import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId, type ProjectWorkPacket } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Work from "./ProjectWorkService.ts";

const actor: Work.ProjectWorkActor = {
  projectId: ProjectId.make("project:work"),
  threadId: ThreadId.make("thread:owner"),
  runId: RunId.make("run:owner"),
  providerSessionId: "session:owner",
};
const child = {
  ...actor,
  threadId: ThreadId.make("thread:child"),
  runId: RunId.make("run:child"),
  providerSessionId: "session:child",
};
const packet: ProjectWorkPacket = {
  objective: "Deliver the finished video and source ZIP inside the product",
  authorizedScope: "Implement, prove, review and merge this project only.",
  sources: [
    {
      reference: "decision:delivery",
      attribution: "user",
      excerpt: "The video and source ZIP must both be delivered inside the product.",
    },
  ],
  criteria: [
    {
      id: "video",
      description: "Finished video is delivered in the product",
      requiredEvidence: ["runtime"],
    },
    {
      id: "zip",
      description: "Source ZIP is delivered in the product",
      requiredEvidence: ["runtime"],
    },
  ],
  dependencies: [],
};
const layer = Work.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));

it.effect(
  "refuses missing ZIP and stale artifact evidence, then completes the promised boundary",
  () =>
    Effect.gen(function* () {
      const service = yield* Work.ProjectWorkService;
      let work = yield* service.mutate(actor, {
        requestId: "create",
        operation: { action: "create", workId: "delivery", packet },
      });
      work = yield* service.mutate(child, {
        requestId: "claim",
        operation: { action: "claim", workId: work.id, expectedVersion: work.version },
      });
      assert.deepEqual(work.assignment?.packet, packet);
      const assignmentId = work.assignment?.id ?? "missing";
      const complete = () =>
        service.mutate(child, {
          requestId: "complete",
          operation: {
            action: "complete",
            workId: work.id,
            expectedVersion: work.version,
            assignmentId,
            artifactRevision: "commit:2",
          },
        });
      const record = (criterionId: string, artifactRevision: string) =>
        service.mutate(child, {
          requestId: `evidence:${criterionId}:${artifactRevision}`,
          operation: {
            action: "evidence",
            workId: work.id,
            expectedVersion: work.version,
            assignmentId,
            evidence: {
              criterionId,
              kind: "runtime",
              artifact: `artifact:${criterionId}`,
              artifactRevision,
              result: "passed",
              observation: "Opened the delivered artifact in the product.",
              attribution: "agent observed runtime",
            },
          },
        });
      work = yield* record("video", "commit:2");
      assert.deepEqual(
        yield* Effect.flip(complete()),
        new Work.ProjectWorkError({ reason: "missing_evidence" }),
      );
      work = yield* record("zip", "commit:1");
      assert.deepEqual(
        yield* Effect.flip(complete()),
        new Work.ProjectWorkError({ reason: "missing_evidence" }),
      );
      work = yield* record("zip", "commit:2");
      work = yield* complete();
      assert.equal(work.state, "completed");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "replays lost replies, rejects changed request payloads and serializes competing claims",
  () =>
    Effect.gen(function* () {
      const service = yield* Work.ProjectWorkService;
      const create = {
        requestId: "create",
        operation: { action: "create" as const, workId: "delivery", packet },
      };
      const work = yield* service.mutate(actor, create);
      assert.deepEqual(
        yield* service.mutate(
          { ...actor, runId: RunId.make("run:later"), providerSessionId: "session:later" },
          create,
        ),
        work,
      );
      assert.deepEqual(
        yield* Effect.flip(
          service.mutate(actor, {
            ...create,
            operation: {
              ...create.operation,
              packet: { ...packet, objective: "Different objective" },
            },
          }),
        ),
        new Work.ProjectWorkError({ reason: "request_conflict" }),
      );
      const claim = {
        requestId: "claim",
        operation: { action: "claim" as const, workId: work.id, expectedVersion: work.version },
      };
      const results = yield* Effect.all(
        [
          service.mutate(child, claim).pipe(Effect.result),
          service.mutate(actor, claim).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(results.filter((result) => result._tag === "Success").length, 1);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM project_work_assignments`;
      assert.equal(rows[0]?.count, 1);
    }).pipe(Effect.provide(layer)),
);

it.effect("fences old assignments and runs while retaining their immutable context", () =>
  Effect.gen(function* () {
    const service = yield* Work.ProjectWorkService;
    const created = yield* service.mutate(actor, {
      requestId: "create",
      operation: { action: "create", workId: "delivery", packet },
    });
    const claimed = yield* service.mutate(child, {
      requestId: "claim",
      operation: { action: "claim", workId: created.id, expectedVersion: created.version },
    });
    const assignmentId = claimed.assignment?.id ?? "missing";
    const wait = {
      requestId: "wait",
      operation: {
        action: "wait" as const,
        workId: claimed.id,
        expectedVersion: claimed.version,
        assignmentId,
        releaseCondition: "Artifact is available",
      },
    };
    assert.deepEqual(
      yield* Effect.flip(service.mutate({ ...child, runId: RunId.make("run:replacement") }, wait)),
      new Work.ProjectWorkError({ reason: "not_assigned" }),
    );
    assert.deepEqual(
      yield* Effect.flip(
        service.mutate(child, {
          requestId: "revise",
          operation: {
            action: "revise",
            workId: claimed.id,
            expectedVersion: claimed.version,
            packet,
          },
        }),
      ),
      new Work.ProjectWorkError({ reason: "not_owner" }),
    );
    const revised = yield* service.mutate(actor, {
      requestId: "revise",
      operation: {
        action: "revise",
        workId: claimed.id,
        expectedVersion: claimed.version,
        packet: { ...packet, authorizedScope: "Changed scope" },
      },
    });
    assert.equal(revised.revision, 2);
    assert.equal(revised.assignment, null);
    assert.deepEqual(
      yield* Effect.flip(
        service.mutate(child, {
          ...wait,
          operation: { ...wait.operation, expectedVersion: revised.version },
        }),
      ),
      new Work.ProjectWorkError({ reason: "not_assigned" }),
    );
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      assignment_json: string;
    }>`SELECT assignment_json FROM project_work_assignments`;
    assert.include(rows[0]?.assignment_json ?? "", packet.authorizedScope);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "rejects cycles, unavailable dependencies, cross-project reads and forged ownership",
  () =>
    Effect.gen(function* () {
      const service = yield* Work.ProjectWorkService;
      const first = yield* service.mutate(actor, {
        requestId: "first",
        operation: { action: "create", workId: "first", packet },
      });
      const second = yield* service.mutate(actor, {
        requestId: "second",
        operation: {
          action: "create",
          workId: "second",
          packet: { ...packet, dependencies: ["first"] },
        },
      });
      assert.deepEqual(
        yield* Effect.flip(
          service.mutate(child, {
            requestId: "claim",
            operation: { action: "claim", workId: second.id, expectedVersion: second.version },
          }),
        ),
        new Work.ProjectWorkError({ reason: "dependency_pending" }),
      );
      assert.deepEqual(
        yield* Effect.flip(
          service.mutate(actor, {
            requestId: "cycle",
            operation: {
              action: "revise",
              workId: first.id,
              expectedVersion: first.version,
              packet: { ...packet, dependencies: ["second"] },
            },
          }),
        ),
        new Work.ProjectWorkError({ reason: "dependency_cycle" }),
      );
      const foreign = { ...actor, projectId: ProjectId.make("project:foreign") };
      assert.deepEqual(
        yield* Effect.flip(service.read(foreign.projectId, { workId: first.id })),
        new Work.ProjectWorkError({ reason: "not_found" }),
      );
      assert.deepEqual(
        yield* Effect.flip(
          service.mutate(foreign, {
            requestId: "cross",
            operation: {
              action: "create",
              workId: "cross",
              packet: { ...packet, dependencies: [first.id] },
            },
          }),
        ),
        new Work.ProjectWorkError({ reason: "not_found" }),
      );
      assert.deepEqual(
        yield* Effect.flip(
          service.mutate(child, {
            requestId: "cancel",
            operation: {
              action: "cancel",
              workId: first.id,
              expectedVersion: first.version,
              reason: "No ownership",
            },
          }),
        ),
        new Work.ProjectWorkError({ reason: "not_owner" }),
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("keeps human acceptance pending and requires explicit wait resolution", () =>
  Effect.gen(function* () {
    const service = yield* Work.ProjectWorkService;
    let work = yield* service.mutate(actor, {
      requestId: "create",
      operation: {
        action: "create",
        workId: "approval",
        packet: {
          ...packet,
          criteria: [
            {
              id: "acceptance",
              description: "User approves delivery",
              requiredEvidence: ["human_acceptance"],
            },
          ],
        },
      },
    });
    work = yield* service.mutate(child, {
      requestId: "claim",
      operation: { action: "claim", workId: work.id, expectedVersion: work.version },
    });
    const assignmentId = work.assignment?.id ?? "missing";
    const complete = () =>
      service.mutate(child, {
        requestId: "complete",
        operation: {
          action: "complete",
          workId: work.id,
          expectedVersion: work.version,
          assignmentId,
          artifactRevision: "commit:1",
        },
      });
    assert.deepEqual(
      yield* Effect.flip(complete()),
      new Work.ProjectWorkError({ reason: "human_acceptance_pending" }),
    );
    work = yield* service.mutate(child, {
      requestId: "wait",
      operation: {
        action: "wait",
        workId: work.id,
        expectedVersion: work.version,
        assignmentId,
        releaseCondition: "Human acceptance is recorded through an authenticated user interface",
      },
    });
    assert.deepEqual(
      yield* Effect.flip(complete()),
      new Work.ProjectWorkError({ reason: "invalid_state" }),
    );
    work = yield* service.mutate(child, {
      requestId: "resume",
      operation: {
        action: "resume",
        workId: work.id,
        expectedVersion: work.version,
        assignmentId,
        resolution: "Review interface available",
      },
    });
    assert.equal(work.waitCondition, null);
    assert.deepEqual(
      yield* Effect.flip(complete()),
      new Work.ProjectWorkError({ reason: "human_acceptance_pending" }),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("resumes a waiting assignment on a new run without inheriting unreviewed evidence", () =>
  Effect.gen(function* () {
    const service = yield* Work.ProjectWorkService;
    let work = yield* service.mutate(actor, {
      requestId: "create",
      operation: { action: "create", workId: "delivery", packet },
    });
    work = yield* service.mutate(child, {
      requestId: "claim",
      operation: { action: "claim", workId: work.id, expectedVersion: work.version },
    });
    const original = work.assignment;
    const assignmentId = original?.id ?? "missing";
    work = yield* service.mutate(child, {
      requestId: "evidence",
      operation: {
        action: "evidence",
        workId: work.id,
        expectedVersion: work.version,
        assignmentId,
        evidence: {
          criterionId: "video",
          kind: "runtime",
          artifact: "video",
          artifactRevision: "commit:1",
          result: "passed",
          observation: "Video delivered",
          attribution: "runtime observed",
        },
      },
    });
    work = yield* service.mutate(child, {
      requestId: "wait",
      operation: {
        action: "wait",
        workId: work.id,
        expectedVersion: work.version,
        assignmentId,
        releaseCondition: "ZIP upload completes",
      },
    });
    const waiting = work;
    const resume = {
      requestId: "resume",
      operation: {
        action: "resume" as const,
        workId: work.id,
        expectedVersion: work.version,
        assignmentId,
        resolution: "ZIP upload finished; verify both current artifacts",
      },
    };
    assert.deepEqual(
      yield* Effect.flip(service.mutate(actor, resume)),
      new Work.ProjectWorkError({ reason: "not_assigned" }),
    );
    const nextRun = { ...child, runId: RunId.make("run:next"), providerSessionId: "session:next" };
    work = yield* service.mutate(nextRun, resume);
    assert.notEqual(work.assignment?.id, original?.id);
    assert.equal(work.assignment?.runId, nextRun.runId);
    assert.deepEqual(work.assignment?.packet, packet);
    assert.deepEqual(work.evidence, []);
    assert.deepEqual(
      yield* service.read(actor.projectId, { workId: work.id, version: waiting.version }),
      waiting,
    );
    assert.equal(work.lastTransition.reason, resume.operation.resolution);
    assert.deepEqual(
      yield* Effect.flip(
        service.mutate(child, {
          requestId: "old-complete",
          operation: {
            action: "complete",
            workId: work.id,
            expectedVersion: work.version,
            assignmentId,
            artifactRevision: "commit:1",
          },
        }),
      ),
      new Work.ProjectWorkError({ reason: "not_assigned" }),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("reloads accepted assignments and receipts after closing and reopening SQLite", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-work-restart-" });
    const database = `${directory}/work.sqlite`;
    const provide = () =>
      Work.layer.pipe(
        Layer.provide(Sqlite.layerFromPath(database)),
        Layer.provide(NodeServices.layer),
      );
    const claim = {
      requestId: "claim",
      operation: { action: "claim" as const, workId: "delivery", expectedVersion: 1 },
    };
    const accepted = yield* Effect.gen(function* () {
      const service = yield* Work.ProjectWorkService;
      yield* service.mutate(actor, {
        requestId: "create",
        operation: { action: "create", workId: "delivery", packet },
      });
      return yield* service.mutate(child, claim);
    }).pipe(Effect.provide(provide()));
    yield* Effect.gen(function* () {
      const service = yield* Work.ProjectWorkService;
      assert.deepEqual(yield* service.read(actor.projectId, { workId: "delivery" }), accepted);
      assert.deepEqual(yield* service.mutate(child, claim), accepted);
    }).pipe(Effect.provide(provide()));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
