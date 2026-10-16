import * as Schema from "effect/Schema";

const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));

// Only a digest leaves the provider boundary. Display text is never an authority.
export const ApprovalScope = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literals(["command", "network"]),
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type ApprovalScope = typeof ApprovalScope.Type;

export const DeclineFeedback = Schema.String.check(Schema.makeFilter((value: string) =>
  value.trim().length > 0 && Array.from(value).length <= 4000));

export const ApprovalDecisionContext = Schema.Struct({
  commandId: Identifier,
  attemptId: Identifier,
  expectedApprovalScope: Schema.optional(ApprovalScope),
  ruleSourceRequestId: Schema.optional(Identifier),
  feedback: Schema.optional(DeclineFeedback),
});
export type ApprovalDecisionContext = typeof ApprovalDecisionContext.Type;
