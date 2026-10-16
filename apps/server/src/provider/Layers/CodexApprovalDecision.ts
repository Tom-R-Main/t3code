// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import { domainToASCII } from "node:url";
import * as NodePath from "node:path";
import { Buffer } from "node:buffer";
import { ApprovalDecisionContext, type ApprovalScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";
import { sanitizeAcpStderrExcerpt } from "../acp/AcpStderr.ts";

export class CodexApprovalDecisionError extends Schema.TaggedError<CodexApprovalDecisionError>()(
  "CodexApprovalDecisionError",
  { code: Schema.String },
) {
  override get message(): string { return this.code; }
}
const failure = (code: string) => new CodexApprovalDecisionError({ code });
const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

function canonicalNetworkHost(host: string): string | undefined {
  // Node's URL-backed IDNA conversion can discard a path/query or decode a
  // percent escape. Reject URL syntax first: this authority is a typed host.
  if (/[\\/:@*?#%\s\u0000-\u001f\u007f]/.test(host)) return undefined;
  const canonical = domainToASCII(host.toLowerCase().replace(/\.$/, ""));
  return canonical && canonical.length <= 253 && canonical.split(".").every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? canonical : undefined;
}

export function codexNetworkApprovalTarget(payload: Pick<CodexSchema.CommandExecutionRequestApprovalParams, "networkApprovalContext">): string | undefined {
  const context = payload.networkApprovalContext;
  const host = context ? canonicalNetworkHost(context.host) : undefined;
  return context && host ? `Network target: ${context.protocol} ${host}` : undefined;
}

export function codexNetworkApprovalScope(
  sessionIncarnation: string,
  payload: CodexSchema.CommandExecutionRequestApprovalParams,
): ApprovalScope | undefined {
  const context = payload.networkApprovalContext;
  if (!context || !sessionIncarnation) return undefined;
  // This field is a typed host, not a URL, shell string, or display action.
  const host = canonicalNetworkHost(context.host);
  if (!host) return undefined;
  return {
    version: 1,
    kind: "network",
    digest: digest(JSON.stringify([
      1, "network", sessionIncarnation, payload.environmentId ?? null, context.protocol, host,
    ])),
  };
}

interface CommandApprovalPayload extends CodexSchema.CommandExecutionRequestApprovalParams {
  readonly siftCommandScope?: unknown;
}

const CommandScope = Schema.Struct({
  version: Schema.Literal(1),
  program: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  argv: Schema.Array(Schema.String.check(Schema.isMaxLength(16384))).check(
    Schema.isMinLength(1), Schema.isMaxLength(256),
  ),
  cwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
});
const isCommandScope = Schema.is(CommandScope);
const MAX_EXACT_COMMAND_DISPLAY_CHARS = 4096;

function authoritativeCommandScope(payload: CommandApprovalPayload): typeof CommandScope.Type | undefined {
  const scope = payload.siftCommandScope;
  if (payload.networkApprovalContext || !isCommandScope(scope)) return undefined;
  const strings = [scope.program, ...scope.argv, scope.cwd];
  // Reject malformed UTF-16 before UTF-8 encoding: Node would replace lone
  // surrogates, collapsing distinct decoded operands onto the same byte string.
  const malformedUnicode = strings.some((value) => Array.from(value).some((character) => {
    const point = character.codePointAt(0)!;
    return point >= 0xd800 && point <= 0xdfff;
  }));
  if (malformedUnicode || strings.some((value) => value.includes("\0")) ||
    !NodePath.isAbsolute(scope.program) || !NodePath.isAbsolute(scope.cwd) || scope.argv[0] === "" ||
    Buffer.byteLength(scope.program) > 4096 || Buffer.byteLength(scope.cwd) > 4096 ||
    scope.argv.some((arg) => Buffer.byteLength(arg) > 16384) ||
    strings.reduce((total, value) => total + Buffer.byteLength(value), 0) > 65536) return undefined;
  return scope;
}

function canonicalCommandDisplay(scope: typeof CommandScope.Type): string {
  // JSON preserves argument boundaries, quotes and escaped whitespace. This is
  // display only; execution never re-parses it into a shell command.
  return `Program: ${JSON.stringify(scope.program)}\nArguments (argv): ${JSON.stringify(scope.argv)}\nWorking directory: ${JSON.stringify(scope.cwd)}`;
}

export function codexCommandApprovalScope(
  sessionIncarnation: string,
  payload: CommandApprovalPayload,
): ApprovalScope | undefined {
  const scope = authoritativeCommandScope(payload);
  if (!sessionIncarnation || !scope) return undefined;
  const canonical = canonicalCommandDisplay(scope);
  // A human cannot grant exact reusable authority over hidden, redacted or
  // truncated operands. Keep the native one-time choice in those cases.
  if (canonical.length > MAX_EXACT_COMMAND_DISPLAY_CHARS || sanitizeAcpStderrExcerpt(canonical) !== canonical)
    return undefined;
  return {
    version: 1,
    kind: "command",
    digest: digest(JSON.stringify([
      1, "command", sessionIncarnation, payload.environmentId ?? null, scope.program, scope.argv, scope.cwd,
    ])),
  };
}

export function codexApprovalPublicPayload(payload: CommandApprovalPayload): CodexSchema.CommandExecutionRequestApprovalParams {
  const { siftCommandScope: _scope, ...publicPayload } = payload;
  const scope = authoritativeCommandScope(payload);
  if (!scope) return publicPayload;
  const canonical = canonicalCommandDisplay(scope);
  // The canonical, sanitized display replaces the provider's shell-shaped
  // presentation. Raw extension fields and parsed display actions stay private.
  const { commandActions: _actions, ...remaining } = publicPayload;
  return {
    ...remaining,
    command: canonical.length <= MAX_EXACT_COMMAND_DISPLAY_CHARS
      ? sanitizeAcpStderrExcerpt(canonical)
      : "Exact command details exceed the display limit. Only one-time approval is supported.",
    cwd: sanitizeAcpStderrExcerpt(scope.cwd),
    ...(payload.reason ? { reason: sanitizeAcpStderrExcerpt(payload.reason) } : {}),
  };
}

export function assertApprovalScope(
  expected: ApprovalScope | undefined,
  actual: ApprovalScope | undefined,
): void {
  if (expected && (!actual || expected.version !== actual.version || expected.kind !== actual.kind ||
    expected.digest !== actual.digest)) throw failure("APPROVAL_SCOPE_MISMATCH");
}

export interface DeclineFeedbackJournal {
  readonly reserve: (requestId: string, context: ApprovalDecisionContext) =>
    Effect.Effect<"new" | "delivered", CodexApprovalDecisionError>;
  readonly delivered: (requestId: string) => Effect.Effect<void, CodexApprovalDecisionError>;
}

export function makeDeclineFeedbackJournal(sql: SqlClient.SqlClient): DeclineFeedbackJournal {
  return {
    reserve: (requestId, context) => Effect.gen(function* () {
      yield* sql`CREATE TABLE IF NOT EXISTS sift_decline_feedback (
        request_id TEXT PRIMARY KEY, command_id TEXT NOT NULL,
        payload_digest TEXT NOT NULL, phase TEXT NOT NULL CHECK (phase IN ('delivery_unknown', 'delivered'))
      )`;
      const payload = yield* Schema.encodeEffect(Schema.fromJsonString(ApprovalDecisionContext))(context);
      const payloadDigest = digest(payload);
      const inserted = yield* sql<{ request_id: string }>`INSERT INTO sift_decline_feedback
        (request_id, command_id, payload_digest, phase)
        VALUES (${requestId}, ${context.commandId}, ${payloadDigest}, 'delivery_unknown')
        ON CONFLICT(request_id) DO NOTHING RETURNING request_id`;
      if (inserted.length > 0) return "new" as const;
      const rows = yield* sql<{ command_id: string; payload_digest: string; phase: string }>`
        SELECT command_id, payload_digest, phase FROM sift_decline_feedback WHERE request_id = ${requestId}`;
      const row = rows[0];
      if (!row || row.command_id !== context.commandId || row.payload_digest !== payloadDigest)
        return yield* failure("FEEDBACK_COMMAND_CONFLICT");
      if (row.phase !== "delivered") return yield* failure("FEEDBACK_DELIVERY_UNKNOWN");
      return "delivered" as const;
    }).pipe(Effect.mapError((error) => Schema.is(CodexApprovalDecisionError)(error)
      ? error : failure("FEEDBACK_JOURNAL_FAILED"))),
    delivered: (requestId) => sql`UPDATE sift_decline_feedback SET phase = 'delivered'
      WHERE request_id = ${requestId}`.pipe(
        Effect.asVoid,
        Effect.mapError(() => failure("FEEDBACK_JOURNAL_FAILED")),
      ),
  };
}

// Reserving before transport makes an interrupted or lost reply non-retryable.
// clientUserMessageId is correlation only; Codex does not promise deduplication.
export const deliverDeclineFeedback = Effect.fn("deliverDeclineFeedback")(function* (input: {
  readonly client: Pick<CodexClient.CodexAppServerClient["Service"], "request">;
  readonly journal: DeclineFeedbackJournal;
  readonly requestId: string;
  readonly providerThreadId: string;
  readonly pendingTurnId: string;
  readonly activeTurnId: Effect.Effect<string | undefined>;
  readonly context: ApprovalDecisionContext;
}) {
  const feedback = input.context.feedback;
  if (!feedback?.trim() || Array.from(feedback).length > 4000) return yield* failure("INVALID_DECLINE_FEEDBACK");
  if ((yield* input.activeTurnId) !== input.pendingTurnId)
    return yield* failure("FEEDBACK_STALE_TURN");
  const reserved = yield* input.journal.reserve(input.requestId, input.context);
  if (reserved === "new") {
    const result = yield* input.client.request("turn/steer", {
      threadId: input.providerThreadId,
      expectedTurnId: input.pendingTurnId,
      clientUserMessageId: `sift-feedback-${digest(input.context.commandId)}`,
      input: [{ type: "text", text: feedback, text_elements: [] }],
    }).pipe(Effect.mapError(() => failure("FEEDBACK_DELIVERY_UNKNOWN")));
    if (result.turnId !== input.pendingTurnId) return yield* failure("FEEDBACK_DELIVERY_UNKNOWN");
    yield* input.journal.delivered(input.requestId);
  }
  if ((yield* input.activeTurnId) !== input.pendingTurnId)
    return yield* failure("FEEDBACK_STALE_TURN");
});
