import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

const Codes = Schema.Literals([
  "FEEDBACK_DELIVERY_UNKNOWN",
  "APPROVAL_SCOPE_MISMATCH",
  "FEEDBACK_STALE_TURN",
  "FEEDBACK_COMMAND_CONFLICT",
  "FEEDBACK_JOURNAL_FAILED",
  "INVALID_DECLINE_FEEDBACK",
  "FEEDBACK_UNSUPPORTED",
  "INVALID_RULE_APPLICATION",
  "GUARDED_DECISION_MUST_BE_ONE_TIME",
  "APPROVAL_ALREADY_RELEASED",
  "APPROVAL_ALREADY_RESOLVED",
  "APPROVAL_EFFECT_UNKNOWN",
  "PROVIDER_DECISION_FAILED",
  "PROVIDER_SESSION_UNAVAILABLE",
]);
export type ApprovalEffectErrorCode = typeof Codes.Type;
const DecisionError = Schema.Struct({
  _tag: Schema.Literal("CodexApprovalDecisionError"),
  code: Codes,
});
const WrappedError = Schema.Struct({ cause: Schema.Unknown });

export function approvalEffectErrorCode(cause: Cause.Cause<unknown>): ApprovalEffectErrorCode {
  let error: unknown = Option.getOrUndefined(Cause.findErrorOption(cause));
  for (let depth = 0; depth < 8; depth++) {
    if (Schema.is(DecisionError)(error)) return error.code;
    if (!Schema.is(WrappedError)(error)) break;
    error = error.cause;
  }
  return "PROVIDER_DECISION_FAILED";
}

export const ensureApprovalEffects = (
  sql: SqlClient.SqlClient,
) => sql`CREATE TABLE IF NOT EXISTS sift_approval_effects (
  command_id TEXT PRIMARY KEY, request_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('queued', 'executing', 'accepted', 'failed')),
  feedback INTEGER NOT NULL, error_code TEXT, sequence INTEGER NOT NULL DEFAULT 0
)`;

export const recoverApprovalEffects = (sql: SqlClient.SqlClient) => sql`UPDATE sift_approval_effects
  SET phase = 'failed', error_code = CASE WHEN feedback = 1 THEN 'FEEDBACK_DELIVERY_UNKNOWN' ELSE 'APPROVAL_EFFECT_UNKNOWN' END
  WHERE phase IN ('queued', 'executing')`;

// Dispatch can fail before its orchestration event is durable. A reserved row
// must not remain pending forever or be redispatched after an uncertain result.
// An already executing effect keeps its own runtime completion receipt.
export const failQueuedApprovalEffect = (sql: SqlClient.SqlClient, commandId: string) =>
  sql`UPDATE sift_approval_effects
  SET phase = 'failed', error_code = CASE WHEN feedback = 1 THEN 'FEEDBACK_DELIVERY_UNKNOWN' ELSE 'APPROVAL_EFFECT_UNKNOWN' END
  WHERE command_id = ${commandId} AND phase = 'queued'`.pipe(Effect.asVoid);

export const reserveApprovalEffect = (
  sql: SqlClient.SqlClient,
  commandId: string,
  requestId: string,
  feedback: boolean,
) =>
  sql<{
    command_id: string;
  }>`INSERT INTO sift_approval_effects (command_id, request_id, phase, feedback)
    VALUES (${commandId}, ${requestId}, 'queued', ${feedback ? 1 : 0})
    ON CONFLICT(command_id) DO NOTHING RETURNING command_id`.pipe(
    Effect.map((rows) => rows.length > 0),
  );

// A reactor replay after an uncertain provider outcome cannot call the provider again.
export const beginApprovalEffect = (sql: SqlClient.SqlClient, commandId: string) =>
  sql<{ command_id: string }>`UPDATE sift_approval_effects SET phase = 'executing'
    WHERE command_id = ${commandId} AND phase = 'queued' RETURNING command_id`.pipe(
    Effect.map((rows) => rows.length > 0),
  );

export const finishApprovalEffect = (
  sql: SqlClient.SqlClient,
  commandId: string,
  error?: ApprovalEffectErrorCode,
) =>
  sql`UPDATE sift_approval_effects SET phase = ${error ? "failed" : "accepted"}, error_code = ${error ?? null}
    WHERE command_id = ${commandId} AND phase = 'executing'`.pipe(Effect.asVoid);

export const readApprovalEffect = Effect.fn("readApprovalEffect")(function* (
  sql: SqlClient.SqlClient,
  commandId: string,
) {
  const rows = yield* sql<{ phase: string; error_code: string | null; sequence: number }>`
    SELECT phase, error_code, sequence FROM sift_approval_effects WHERE command_id = ${commandId}`;
  const row = rows[0];
  if (row?.phase === "accepted") return { state: "accepted" as const, sequence: row.sequence };
  if (row?.phase === "failed")
    return {
      state: "failed" as const,
      error:
        row.error_code && Schema.is(Codes)(row.error_code)
          ? row.error_code
          : "PROVIDER_DECISION_FAILED",
    };
  return { state: "pending" as const, sequence: row?.sequence ?? 0 };
});
