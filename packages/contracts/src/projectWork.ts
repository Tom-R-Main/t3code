import * as Schema from "effect/Schema";
import { PositiveInt, ProjectId, RunId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const text = (length: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(length));
const key = text(128);
const ProjectWorkEvidenceKind = Schema.Literals([
  "fixture",
  "runtime",
  "model_review",
  "human_acceptance",
]);
export const ProjectWorkPacket = Schema.Struct({
  objective: text(4000),
  authorizedScope: text(8000),
  sources: Schema.Array(
    Schema.Struct({
      reference: text(2000),
      attribution: text(500),
      excerpt: text(8000),
    }),
  ).check(Schema.isMaxLength(16)),
  criteria: Schema.Array(
    Schema.Struct({
      id: key,
      description: text(2000),
      requiredEvidence: Schema.Array(ProjectWorkEvidenceKind).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(4),
      ),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  dependencies: Schema.Array(key).check(Schema.isMaxLength(32)),
});
export type ProjectWorkPacket = typeof ProjectWorkPacket.Type;

export const ProjectWorkAssignment = Schema.Struct({
  id: key,
  revision: PositiveInt,
  threadId: ThreadId,
  runId: RunId,
  providerSessionId: text(512),
  packet: ProjectWorkPacket,
});
export type ProjectWorkAssignment = typeof ProjectWorkAssignment.Type;

const EvidenceInput = Schema.Struct({
  criterionId: key,
  kind: Schema.Literals(["fixture", "runtime", "model_review"]),
  artifact: text(2000),
  artifactRevision: text(256),
  result: Schema.Literals(["passed", "failed"]),
  observation: text(4000),
  attribution: text(1000),
});
const ProjectWorkEvidence = Schema.Struct({
  ...EvidenceInput.fields,
  assignmentId: key,
  revision: PositiveInt,
  recordedByThreadId: ThreadId,
  recordedByRunId: RunId,
});

export const ProjectWork = Schema.Struct({
  id: key,
  projectId: ProjectId,
  ownerThreadId: ThreadId,
  version: PositiveInt,
  revision: PositiveInt,
  state: Schema.Literals(["open", "active", "waiting", "completed", "cancelled"]),
  packet: ProjectWorkPacket,
  assignment: Schema.NullOr(ProjectWorkAssignment),
  waitCondition: Schema.NullOr(text(2000)),
  evidence: Schema.Array(ProjectWorkEvidence),
  lastTransition: Schema.Struct({
    action: key,
    threadId: ThreadId,
    runId: RunId,
    reason: Schema.NullOr(text(2000)),
  }),
});
export type ProjectWork = typeof ProjectWork.Type;

const current = { workId: key, expectedVersion: PositiveInt };
export const ProjectWorkMutation = Schema.Struct({
  requestId: key,
  operation: Schema.Union([
    Schema.Struct({ action: Schema.Literal("create"), workId: key, packet: ProjectWorkPacket }),
    Schema.Struct({ action: Schema.Literal("revise"), ...current, packet: ProjectWorkPacket }),
    Schema.Struct({ action: Schema.Literal("claim"), ...current }),
    Schema.Struct({
      action: Schema.Literal("evidence"),
      ...current,
      assignmentId: key,
      evidence: EvidenceInput,
    }),
    Schema.Struct({
      action: Schema.Literal("complete"),
      ...current,
      assignmentId: key,
      artifactRevision: text(256),
    }),
    Schema.Struct({
      action: Schema.Literal("wait"),
      ...current,
      assignmentId: key,
      releaseCondition: text(2000),
    }),
    Schema.Struct({
      action: Schema.Literal("resume"),
      ...current,
      assignmentId: key,
      resolution: text(2000),
    }),
    Schema.Struct({ action: Schema.Literal("release"), ...current, reason: text(2000) }),
    Schema.Struct({ action: Schema.Literal("cancel"), ...current, reason: text(2000) }),
    Schema.Struct({ action: Schema.Literal("reopen"), ...current, reason: text(2000) }),
  ]),
});
export type ProjectWorkMutation = typeof ProjectWorkMutation.Type;

const ProjectWorkSummary = Schema.Struct({
  id: key,
  version: PositiveInt,
  revision: PositiveInt,
  state: ProjectWork.fields.state,
  objective: text(4000),
  ownerThreadId: ThreadId,
});

export const ProjectWorkRead = Schema.Struct({
  workId: Schema.optional(key),
  version: Schema.optional(PositiveInt),
  after: Schema.optional(key),
});
export type ProjectWorkRead = typeof ProjectWorkRead.Type;
export const ProjectWorkReadResult = Schema.Union([
  ProjectWork,
  Schema.Struct({ items: Schema.Array(ProjectWorkSummary), nextCursor: Schema.NullOr(key) }),
]);
export type ProjectWorkReadResult = typeof ProjectWorkReadResult.Type;
