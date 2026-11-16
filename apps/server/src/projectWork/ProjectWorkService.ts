import {
  ProjectWork,
  ProjectWorkAssignment,
  ProjectWorkMutation,
  ProjectWorkRead,
  type ProjectWorkReadResult,
  type ProjectId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class ProjectWorkError extends Schema.TaggedError<ProjectWorkError>()("ProjectWorkError", {
  reason: Schema.Literals([
    "not_found",
    "exists",
    "version_conflict",
    "request_conflict",
    "not_owner",
    "not_assigned",
    "invalid_state",
    "invalid_packet",
    "dependency_cycle",
    "dependency_pending",
    "missing_evidence",
    "human_acceptance_pending",
  ]),
}) {
  override get message() {
    return `Project work refused: ${this.reason}. Read the current work before retrying.`;
  }
}

export class ProjectWorkStorageError extends Schema.TaggedError<ProjectWorkStorageError>()(
  "ProjectWorkStorageError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Project work storage could not be read or written.";
  }
}

export interface ProjectWorkActor {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly providerSessionId: string;
}

export class ProjectWorkService extends Context.Service<
  ProjectWorkService,
  {
    readonly read: (
      projectId: ProjectId,
      input: ProjectWorkRead,
    ) => Effect.Effect<ProjectWorkReadResult, ProjectWorkError | ProjectWorkStorageError>;
    readonly mutate: (
      actor: ProjectWorkActor,
      input: ProjectWorkMutation,
    ) => Effect.Effect<ProjectWork, ProjectWorkError | ProjectWorkStorageError>;
  }
>()("t3/projectWork/ProjectWorkService") {}

const decodeMutation = Schema.decodeEffect(ProjectWorkMutation);
const decodeRead = Schema.decodeEffect(ProjectWorkRead);
const isProjectWorkError = Schema.is(ProjectWorkError);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const encode = Schema.encodeEffect(Schema.fromJsonString(ProjectWork));
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectWork));
  const encodeInput = Schema.encodeEffect(Schema.fromJsonString(ProjectWorkMutation));
  const encodeAssignment = Schema.encodeEffect(Schema.fromJsonString(ProjectWorkAssignment));

  const get = Effect.fn("ProjectWorkService.get")(function* (projectId: ProjectId, workId: string) {
    const rows = yield* sql<{ work_json: string }>`SELECT work_json FROM project_work
      WHERE project_id = ${projectId} AND work_id = ${workId}`;
    if (!rows[0]) return yield* new ProjectWorkError({ reason: "not_found" });
    return yield* decode(rows[0].work_json);
  });

  const validatePacket = Effect.fn("ProjectWorkService.validatePacket")(function* (
    projectId: ProjectId,
    workId: string,
    packet: ProjectWork["packet"],
  ) {
    if (
      new Set(packet.criteria.map((criterion) => criterion.id)).size !== packet.criteria.length ||
      new Set(packet.dependencies).size !== packet.dependencies.length ||
      packet.criteria.some(
        (criterion) =>
          new Set(criterion.requiredEvidence).size !== criterion.requiredEvidence.length,
      )
    ) {
      return yield* new ProjectWorkError({ reason: "invalid_packet" });
    }
    for (const dependencyId of packet.dependencies) {
      if (dependencyId === workId)
        return yield* new ProjectWorkError({ reason: "dependency_cycle" });
      yield* get(projectId, dependencyId);
      const cycles = yield* sql`WITH RECURSIVE descendants(id) AS (
        SELECT ${dependencyId} UNION
        SELECT d.dependency_id FROM project_work_dependencies d JOIN descendants p ON d.work_id = p.id
        WHERE d.project_id = ${projectId}
      ) SELECT 1 FROM descendants WHERE id = ${workId} LIMIT 1`;
      if (cycles.length > 0) return yield* new ProjectWorkError({ reason: "dependency_cycle" });
    }
  });

  const checkDependencies = Effect.fn("ProjectWorkService.checkDependencies")(function* (
    work: ProjectWork,
  ) {
    const pending = yield* sql`WITH RECURSIVE dependencies(id) AS (
      SELECT dependency_id FROM project_work_dependencies WHERE project_id = ${work.projectId} AND work_id = ${work.id}
      UNION SELECT d.dependency_id FROM project_work_dependencies d JOIN dependencies p ON d.work_id = p.id
      WHERE d.project_id = ${work.projectId}
    ) SELECT 1 FROM dependencies d JOIN project_work w ON w.work_id = d.id AND w.project_id = ${work.projectId}
      WHERE w.state != 'completed' LIMIT 1`;
    if (pending.length > 0) return yield* new ProjectWorkError({ reason: "dependency_pending" });
  });

  const assertAssigned = (work: ProjectWork, actor: ProjectWorkActor, assignmentId: string) =>
    work.assignment?.id === assignmentId &&
    work.assignment.revision === work.revision &&
    work.assignment.threadId === actor.threadId &&
    work.assignment.runId === actor.runId &&
    work.assignment.providerSessionId === actor.providerSessionId
      ? Effect.void
      : Effect.fail(new ProjectWorkError({ reason: "not_assigned" }));

  const apply = Effect.fn("ProjectWorkService.apply")(function* (
    actor: ProjectWorkActor,
    input: ProjectWorkMutation,
  ) {
    const operation = input.operation;
    const lastTransition = {
      action: operation.action,
      threadId: actor.threadId,
      runId: actor.runId,
      reason:
        "reason" in operation
          ? operation.reason
          : "resolution" in operation
            ? operation.resolution
            : "releaseCondition" in operation
              ? operation.releaseCondition
              : null,
    };
    if (operation.action === "create") {
      const existing =
        yield* sql`SELECT 1 FROM project_work WHERE project_id = ${actor.projectId} AND work_id = ${operation.workId}`;
      if (existing.length > 0) return yield* new ProjectWorkError({ reason: "exists" });
      yield* validatePacket(actor.projectId, operation.workId, operation.packet);
      return {
        id: operation.workId,
        projectId: actor.projectId,
        ownerThreadId: actor.threadId,
        version: 1,
        revision: 1,
        state: "open",
        packet: operation.packet,
        assignment: null,
        waitCondition: null,
        evidence: [],
        lastTransition,
      } satisfies ProjectWork;
    }
    const work = yield* get(actor.projectId, operation.workId);
    if (operation.expectedVersion !== work.version)
      return yield* new ProjectWorkError({ reason: "version_conflict" });
    const next = { ...work, version: work.version + 1, lastTransition };
    if (
      operation.action === "revise" ||
      operation.action === "release" ||
      operation.action === "cancel" ||
      operation.action === "reopen"
    ) {
      if (work.ownerThreadId !== actor.threadId)
        return yield* new ProjectWorkError({ reason: "not_owner" });
      if (operation.action === "reopen") {
        if (work.state !== "completed" && work.state !== "cancelled")
          return yield* new ProjectWorkError({ reason: "invalid_state" });
      } else if (work.state === "completed" || work.state === "cancelled") {
        return yield* new ProjectWorkError({ reason: "invalid_state" });
      }
      if (operation.action === "revise") {
        yield* validatePacket(actor.projectId, work.id, operation.packet);
        return {
          ...next,
          revision: work.revision + 1,
          packet: operation.packet,
          state: "open",
          assignment: null,
          waitCondition: null,
          evidence: [],
        } satisfies ProjectWork;
      }
      return {
        ...next,
        state: operation.action === "cancel" ? "cancelled" : "open",
        assignment: null,
        waitCondition: null,
        evidence: [],
      } satisfies ProjectWork;
    }
    if (operation.action === "claim") {
      if (work.state !== "open" || work.assignment !== null)
        return yield* new ProjectWorkError({ reason: "invalid_state" });
      yield* checkDependencies(work);
      const assignment = {
        id: `assignment:${next.version}`,
        revision: work.revision,
        threadId: actor.threadId,
        runId: actor.runId,
        providerSessionId: actor.providerSessionId,
        packet: work.packet,
      } satisfies ProjectWorkAssignment;
      const json = yield* encodeAssignment(assignment);
      yield* sql`INSERT INTO project_work_assignments (project_id, work_id, assignment_id, assignment_json)
        VALUES (${work.projectId}, ${work.id}, ${assignment.id}, ${json})`;
      return { ...next, state: "active", assignment } satisfies ProjectWork;
    }
    if (operation.action === "resume") {
      if (work.state !== "waiting" && work.state !== "active")
        return yield* new ProjectWorkError({ reason: "invalid_state" });
      if (
        work.assignment === null ||
        work.assignment.id !== operation.assignmentId ||
        work.assignment.threadId !== actor.threadId ||
        work.assignment.revision !== work.revision
      ) {
        return yield* new ProjectWorkError({ reason: "not_assigned" });
      }
      yield* checkDependencies(work);
      if (
        work.assignment.runId !== actor.runId ||
        work.assignment.providerSessionId !== actor.providerSessionId
      ) {
        const assignment = {
          ...work.assignment,
          id: `assignment:${next.version}`,
          runId: actor.runId,
          providerSessionId: actor.providerSessionId,
        };
        const json = yield* encodeAssignment(assignment);
        yield* sql`INSERT INTO project_work_assignments (project_id, work_id, assignment_id, assignment_json)
          VALUES (${work.projectId}, ${work.id}, ${assignment.id}, ${json})`;
        return {
          ...next,
          state: "active",
          assignment,
          waitCondition: null,
          evidence: [],
        } satisfies ProjectWork;
      }
      return { ...next, state: "active", waitCondition: null } satisfies ProjectWork;
    }
    yield* assertAssigned(work, actor, operation.assignmentId);
    if (work.state !== "active") return yield* new ProjectWorkError({ reason: "invalid_state" });
    if (operation.action === "wait")
      return {
        ...next,
        state: "waiting",
        waitCondition: operation.releaseCondition,
      } satisfies ProjectWork;
    if (operation.action === "evidence") {
      const evidence = operation.evidence;
      const criterion = work.packet.criteria.find((entry) => entry.id === evidence.criterionId);
      if (!criterion?.requiredEvidence.includes(evidence.kind))
        return yield* new ProjectWorkError({ reason: "invalid_packet" });
      return {
        ...next,
        evidence: [
          ...work.evidence.filter(
            (entry) => entry.criterionId !== evidence.criterionId || entry.kind !== evidence.kind,
          ),
          {
            ...evidence,
            assignmentId: operation.assignmentId,
            revision: work.revision,
            recordedByThreadId: actor.threadId,
            recordedByRunId: actor.runId,
          },
        ],
      } satisfies ProjectWork;
    }
    yield* checkDependencies(work);
    for (const criterion of work.packet.criteria) {
      for (const kind of criterion.requiredEvidence) {
        if (kind === "human_acceptance")
          return yield* new ProjectWorkError({ reason: "human_acceptance_pending" });
        if (
          !work.evidence.some(
            (evidence) =>
              evidence.criterionId === criterion.id &&
              evidence.kind === kind &&
              evidence.result === "passed" &&
              evidence.assignmentId === operation.assignmentId &&
              evidence.revision === work.revision &&
              evidence.artifactRevision === operation.artifactRevision,
          )
        ) {
          return yield* new ProjectWorkError({ reason: "missing_evidence" });
        }
      }
    }
    return { ...next, state: "completed" } satisfies ProjectWork;
  });

  const mutate = Effect.fn("ProjectWorkService.mutate")(
    function* (actor: ProjectWorkActor, raw: ProjectWorkMutation) {
      const input = yield* decodeMutation(raw);
      const inputJson = yield* encodeInput(input);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const receipts = yield* sql<{
            input_json: string;
            result_json: string;
          }>`SELECT input_json, result_json FROM project_work_receipts
        WHERE project_id = ${actor.projectId} AND thread_id = ${actor.threadId} AND request_id = ${input.requestId}`;
          if (receipts[0]) {
            if (receipts[0].input_json !== inputJson)
              return yield* new ProjectWorkError({ reason: "request_conflict" });
            return yield* decode(receipts[0].result_json);
          }
          const work = yield* apply(actor, input);
          const json = yield* encode(work);
          if (input.operation.action === "create") {
            yield* sql`INSERT INTO project_work (project_id, work_id, version, state, work_json)
          VALUES (${work.projectId}, ${work.id}, ${work.version}, ${work.state}, ${json})`;
          } else {
            const updated =
              yield* sql`UPDATE project_work SET version = ${work.version}, state = ${work.state}, work_json = ${json}
          WHERE project_id = ${work.projectId} AND work_id = ${work.id} AND version = ${input.operation.expectedVersion}
          RETURNING version`;
            if (updated.length === 0)
              return yield* new ProjectWorkError({ reason: "version_conflict" });
          }
          yield* sql`INSERT INTO project_work_history (project_id, work_id, version, work_json)
        VALUES (${work.projectId}, ${work.id}, ${work.version}, ${json})`;
          if (input.operation.action === "create" || input.operation.action === "revise") {
            yield* sql`DELETE FROM project_work_dependencies WHERE project_id = ${work.projectId} AND work_id = ${work.id}`;
            for (const dependency of work.packet.dependencies) {
              yield* sql`INSERT INTO project_work_dependencies (project_id, work_id, dependency_id) VALUES (${work.projectId}, ${work.id}, ${dependency})`;
            }
          }
          yield* sql`INSERT INTO project_work_receipts (project_id, thread_id, request_id, input_json, result_json)
        VALUES (${actor.projectId}, ${actor.threadId}, ${input.requestId}, ${inputJson}, ${json})`;
          return work;
        }),
      );
    },
    Effect.mapError((cause) =>
      isProjectWorkError(cause) ? cause : new ProjectWorkStorageError({ cause }),
    ),
  );

  const read = Effect.fn("ProjectWorkService.read")(
    function* (projectId: ProjectId, raw: ProjectWorkRead) {
      const input = yield* decodeRead(raw);
      if (input.version !== undefined) {
        if (input.workId === undefined)
          return yield* new ProjectWorkError({ reason: "invalid_packet" });
        const rows = yield* sql<{ work_json: string }>`SELECT work_json FROM project_work_history
        WHERE project_id = ${projectId} AND work_id = ${input.workId} AND version = ${input.version}`;
        if (!rows[0]) return yield* new ProjectWorkError({ reason: "not_found" });
        return yield* decode(rows[0].work_json);
      }
      if (input.workId !== undefined) return yield* get(projectId, input.workId);
      const rows = yield* sql<{ work_json: string }>`SELECT work_json FROM project_work
      WHERE project_id = ${projectId} AND work_id > ${input.after ?? ""} ORDER BY work_id LIMIT 101`;
      const works = yield* Effect.forEach(rows.slice(0, 100), (row) => decode(row.work_json));
      return {
        items: works.map(({ id, version, revision, state, packet, ownerThreadId }) => ({
          id,
          version,
          revision,
          state,
          objective: packet.objective,
          ownerThreadId,
        })),
        nextCursor: rows.length > 100 ? (works.at(-1)?.id ?? null) : null,
      } satisfies ProjectWorkReadResult;
    },
    Effect.mapError((cause) =>
      isProjectWorkError(cause) ? cause : new ProjectWorkStorageError({ cause }),
    ),
  );

  return ProjectWorkService.of({ read, mutate });
});

export const layer = Layer.effect(ProjectWorkService, make);
