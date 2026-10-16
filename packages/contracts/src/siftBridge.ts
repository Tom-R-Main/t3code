import { ApprovalScope, DeclineFeedback } from "./approvalDecisionContext.ts";
import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt } from "./baseSchemas.ts";
import { ModelSelection, ProviderUserInputAnswers } from "./orchestration.ts";

const SIFT_MANAGED_ACCESS_MAX_TTL_SECONDS = 12 * 60 * 60;
const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
export const SiftBinding = Schema.Struct({
  runtimeId: Identifier,
  workItemId: Identifier,
  leaseGeneration: PositiveInt,
});
const Base = { id: Identifier, binding: SiftBinding };
const Command = { ...Base, commandId: Identifier };
export const SiftBridgeRequest = Schema.Union([
  Schema.Struct({
    ...Base,
    operation: Schema.Literal("bind"),
    checkoutPath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    modelSelection: ModelSelection,
    expectedPreviousGeneration: Schema.optional(PositiveInt),
    runtimeMode: Schema.Literal("approval-required"),
  }),
  Schema.Struct({
    ...Command,
    operation: Schema.Literal("turn"),
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200_000)),
  }),
  Schema.Struct({ ...Command, operation: Schema.Literal("interrupt") }),
  Schema.Struct({ ...Command, operation: Schema.Literal("stop") }),
  Schema.Struct({
    ...Command,
    operation: Schema.Literal("approve"),
    requestId: Identifier,
    decision: Schema.Literals(["accept", "decline", "cancel"]),
    expectedApprovalScope: Schema.optional(ApprovalScope),
    attemptId: Schema.optional(Identifier),
    ruleSourceRequestId: Schema.optional(Identifier),
    feedback: Schema.optional(DeclineFeedback),
  }),
  Schema.Struct({
    ...Command,
    operation: Schema.Literal("answer"),
    requestId: Identifier,
    answers: ProviderUserInputAnswers,
  }),
  // Host-only process attestation: never starts or recovers a provider session.
  Schema.Struct({
    ...Base,
    operation: Schema.Literal("workerPolicy/read"),
    threadId: Identifier,
    challenge: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    prepare: Schema.optional(Schema.Boolean),
  }),
  // Mints a one-time pairing credential for a T3 client limited to this attempt.
  // The server must run with T3_SIFT_MANAGED_ACCESS=1 or the bridge refuses.
  Schema.Struct({
    ...Base,
    operation: Schema.Literal("attach"),
    role: Schema.Literals(["reviewer", "operator"]),
    ttlSeconds: PositiveInt.check(Schema.isLessThanOrEqualTo(SIFT_MANAGED_ACCESS_MAX_TTL_SECONDS)),
    label: Schema.optional(Identifier),
  }),
  // Revokes every managed credential and session in this environment.
  Schema.Struct({ ...Base, operation: Schema.Literal("detach") }),
  Schema.Struct({
    ...Base,
    operation: Schema.Literal("events"),
    afterSequence: NonNegativeInt,
    limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
  }),
]);
export type SiftBridgeRequest = typeof SiftBridgeRequest.Type;
export const SIFT_BRIDGE_MAX_REQUEST_BYTES = 256 * 1024;
export const SIFT_BRIDGE_MAX_RESPONSE_BYTES = 512 * 1024;
