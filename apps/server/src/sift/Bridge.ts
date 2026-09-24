// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  ApprovalRequestId,
  CommandId,
  MessageId,
  ModelSelection,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import {
  SiftBinding,
  SiftBridgeRequest,
  SIFT_BRIDGE_MAX_RESPONSE_BYTES,
} from "../../../../packages/contracts/src/siftBridge.ts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import {
  MANAGED_ROLE_SCOPES,
  advanceAccessEpoch,
  clearManagedGrants,
  ensureManagedAccessTables,
  readAccessEpoch,
  assignmentIds,
  attemptKey,
  encodeManagedSubject,
  isManagedAccessEnabled,
  isManagedSubject,
  recordManagedGrant,
} from "./ManagedAccess.ts";

const decodeRequest = Schema.decodeUnknownEffect(SiftBridgeRequest);
const StoredBinding = Schema.Struct({
  binding: SiftBinding,
  checkoutPath: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: Schema.Literal("approval-required"),
});
const decodeStoredBinding = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredBinding));
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

class BridgeError extends Schema.TaggedError<BridgeError>()("SiftBridgeError", {
  code: Schema.String,
  message: Schema.String,
}) {}
const isBridgeError = Schema.is(BridgeError);
const fail = (code: string, message: string) => new BridgeError({ code, message });
const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );

// One immutable binding per isolated T3 environment. The host daemon owns lease
// validation; this surface cannot grant or renew a lease or bind another tenant.
export const makeSiftBridge = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestrationEngineService;
  const mutex = yield* Semaphore.make(1);
  // Present in the server; absent in engine-only harnesses, where attach fails.
  const environmentAuth = yield* Effect.serviceOption(EnvironmentAuth);
  yield* ensureManagedAccessTables;
  const revokeManagedCredentials = Effect.gen(function* () {
    // Invalidate first: a link redeemed while the lists below are read yields a
    // session for a superseded epoch, which every check already rejects.
    yield* advanceAccessEpoch.pipe(
      Effect.andThen(clearManagedGrants),
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    if (Option.isNone(environmentAuth)) return { revokedPairingLinks: 0, revokedSessions: 0 };
    const auth = environmentAuth.value;
    const links = (yield* auth.listPairingLinks({ excludeSubjects: [] })).filter((link) =>
      isManagedSubject(link.subject),
    );
    yield* Effect.forEach(links, (link) => auth.revokePairingLink(link.id), { discard: true });
    const sessions = (yield* auth.listSessions()).filter((session) =>
      isManagedSubject(session.subject),
    );
    yield* Effect.forEach(sessions, (session) => auth.revokeSession(session.sessionId), {
      discard: true,
    });
    return { revokedPairingLinks: links.length, revokedSessions: sessions.length };
  });
  yield* sql`CREATE TABLE IF NOT EXISTS sift_bridge_binding (slot INTEGER PRIMARY KEY CHECK (slot = 1), payload TEXT NOT NULL, created_at TEXT NOT NULL, ready_generation INTEGER NOT NULL DEFAULT 0)`;
  yield* sql`CREATE TABLE IF NOT EXISTS sift_bridge_commands (command_id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL)`;

  const execute = Effect.fn("SiftBridge.execute")(function* (
    request: SiftBridgeRequest,
    authorize?: () => void,
  ) {
    const checkAuthorization = Effect.try({
      try: () => authorize?.(),
      catch: () => fail("AUTHORIZATION_FAILED", "Host authorization expired before execution."),
    });
    yield* checkAuthorization;
    const dispatch = (command: OrchestrationCommand) =>
      checkAuthorization.pipe(Effect.andThen(engine.dispatch(command)));
    const identity = canonical(request.binding);
    const { threadId, projectId } = assignmentIds(request.binding);
    const prefix: string = threadId;
    const ensureReady = Effect.fn("SiftBridge.ensureReady")(function* (
      configuration: Extract<SiftBridgeRequest, { operation: "bind" }>,
      createdAt: string,
    ) {
      yield* dispatch({
        type: "project.create",
        commandId: CommandId.make(`${prefix}-project`),
        projectId,
        title: "Sift assignment",
        workspaceRoot: configuration.checkoutPath,
        createdAt,
      });
      const receipt = yield* dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${prefix}-thread`),
        threadId,
        projectId,
        title: "Sift assignment",
        modelSelection: configuration.modelSelection,
        runtimeMode: configuration.runtimeMode,
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      // Replay this barrier on a retried rebind too: a crash can occur after the
      // binding CAS but before stop dispatch. Receipt deduplication makes it safe.
      const stopped =
        configuration.binding.leaseGeneration === 1
          ? receipt
          : yield* dispatch({
              type: "thread.session.stop",
              threadId,
              commandId: CommandId.make(
                `${prefix}-generation-${configuration.binding.leaseGeneration}-stop`,
              ),
              createdAt: yield* nowIso,
            });
      // Credentials minted for an earlier attempt must not survive a rebind.
      // Replayed with the rest of this barrier until the generation is ready,
      // so an idempotent bind retry leaves current attachments alone.
      const ready = yield* sql<{
        ready_generation: number;
      }>`SELECT ready_generation FROM sift_bridge_binding WHERE slot = 1`;
      if (ready[0]?.ready_generation !== configuration.binding.leaseGeneration)
        yield* revokeManagedCredentials;
      yield* checkAuthorization;
      yield* sql`UPDATE sift_bridge_binding SET ready_generation = ${configuration.binding.leaseGeneration} WHERE slot = 1`;
      return stopped;
    });
    if (request.operation === "bind") {
      if (!NodePath.isAbsolute(request.checkoutPath))
        return yield* fail("INVALID_CHECKOUT", "An absolute checkout path is required.");
      const checkoutPath = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(request.checkoutPath),
        catch: () => fail("INVALID_CHECKOUT", "Checkout is unavailable."),
      });
      const details = yield* Effect.tryPromise({
        try: () => NodeFSP.stat(checkoutPath),
        catch: () => fail("INVALID_CHECKOUT", "Checkout is unavailable."),
      });
      if (!details.isDirectory())
        return yield* fail("INVALID_CHECKOUT", "Checkout must be a directory.");
      const payload = canonical({
        binding: request.binding,
        checkoutPath,
        modelSelection: request.modelSelection,
        runtimeMode: request.runtimeMode,
      });
      yield* checkAuthorization;
      const now = yield* nowIso;
      yield* sql`INSERT INTO sift_bridge_binding (slot, payload, created_at) VALUES (1, ${payload}, ${now}) ON CONFLICT(slot) DO NOTHING`;
      const rows = yield* sql<{
        payload: string;
        created_at: string;
      }>`SELECT payload, created_at FROM sift_bridge_binding WHERE slot = 1`;
      const stored = rows[0]!;
      const previous = yield* decodeStoredBinding(stored.payload);
      if (stored.payload !== payload) {
        const sameConfiguration =
          canonical({
            binding: { ...previous.binding, leaseGeneration: request.binding.leaseGeneration },
            checkoutPath: previous.checkoutPath,
            modelSelection: previous.modelSelection,
            runtimeMode: previous.runtimeMode,
          }) === payload;
        if (
          !sameConfiguration ||
          request.binding.leaseGeneration <= previous.binding.leaseGeneration ||
          request.expectedPreviousGeneration !== previous.binding.leaseGeneration
        ) {
          return yield* fail(
            "BINDING_CONFLICT",
            "Assignment configuration or expected lease generation does not match.",
          );
        }
        yield* sql`UPDATE sift_bridge_binding SET payload = ${payload}, ready_generation = 0 WHERE slot = 1 AND payload = ${stored.payload}`;
        const advanced = yield* sql<{
          payload: string;
        }>`SELECT payload FROM sift_bridge_binding WHERE slot = 1`;
        if (advanced[0]?.payload !== payload)
          return yield* fail(
            "BINDING_CONFLICT",
            "Another process advanced the assignment generation.",
          );
      }
      const stopped = yield* ensureReady({ ...request, checkoutPath }, stored.created_at);
      return { threadId, projectId, state: "accepted", sequence: stopped.sequence };
    }
    const rows = yield* sql<{
      payload: string;
      created_at: string;
      ready_generation: number;
    }>`SELECT payload, created_at, ready_generation FROM sift_bridge_binding WHERE slot = 1`;
    if (!rows[0]) return yield* fail("NOT_BOUND", "Bind the assignment before sending commands.");
    const binding = {
      ...(yield* decodeStoredBinding(rows[0].payload)),
      id: "stored",
      operation: "bind" as const,
    };
    if (canonical(binding.binding) !== identity)
      return yield* fail(
        "BINDING_CONFLICT",
        "Assignment identity or lease generation does not match.",
      );
    if (rows[0].ready_generation !== binding.binding.leaseGeneration)
      yield* ensureReady(binding, rows[0].created_at);
    if (request.operation === "detach") {
      yield* checkAuthorization;
      return { threadId, state: "detached", ...(yield* revokeManagedCredentials) };
    }
    if (request.operation === "attach") {
      // Outside managed mode these scopes would be environment-wide, so refuse.
      if (!isManagedAccessEnabled())
        return yield* fail("MANAGED_ACCESS_DISABLED", "Managed access is not enabled here.");
      if (Option.isNone(environmentAuth))
        return yield* fail("MANAGED_ACCESS_UNAVAILABLE", "Client credentials are unavailable.");
      yield* checkAuthorization;
      const notAfterMs = (yield* Clock.currentTimeMillis) + request.ttlSeconds * 1000;
      const issued = yield* environmentAuth.value.createPairingLink({
        // The one-time credential only has to reach a client; the session it
        // creates is bounded by the deadline in its subject.
        ttl: Duration.seconds(Math.min(request.ttlSeconds, 15 * 60)),
        scopes: MANAGED_ROLE_SCOPES[request.role],
        subject: encodeManagedSubject({
          role: request.role,
          attemptKey: attemptKey(
            request.binding,
            yield* readAccessEpoch.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
          ),
          notAfterMs,
        }),
        label: request.label ?? `Sift ${request.role}`,
      });
      // Recorded before the credential leaves the bridge; redemption must match it.
      yield* recordManagedGrant(issued.credential, issued.subject, yield* nowIso).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      return {
        threadId,
        projectId,
        role: request.role,
        scopes: issued.scopes,
        credential: issued.credential,
        pairingLinkId: issued.id,
        redeemBy: DateTime.formatIso(issued.expiresAt),
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(notAfterMs)),
      };
    }
    if (request.operation === "events") {
      const headSequence = yield* engine.latestSequence;
      if (request.afterSequence > headSequence)
        return yield* fail("INVALID_CURSOR", "Cursor is ahead of the authoritative event log.");
      const limit = request.limit ?? 100;
      const page = yield* engine
        .readThreadEvents({
          threadId,
          fromSequenceExclusive: request.afterSequence,
          toSequenceInclusive: headSequence,
          limit: limit + 1,
        })
        .pipe(Stream.runCollect);
      const events: OrchestrationEvent[] = [];
      let bytes = 4096;
      for (const event of page) {
        // @effect-diagnostics-next-line preferSchemaOverJson:off - measures the serialized reply size, not a decode.
        const size = Buffer.byteLength(JSON.stringify(event)) + 1;
        if (events.length === limit || bytes + size > SIFT_BRIDGE_MAX_RESPONSE_BYTES) break;
        events.push(event);
        bytes += size;
      }
      if (events.length === 0 && page.length > 0)
        return yield* fail(
          "EVENT_TOO_LARGE",
          "The next event exceeds the bridge response bound; cursor was not advanced.",
        );
      const hasMore = events.length < page.length;
      return {
        threadId,
        events,
        headSequence,
        nextSequence: hasMore ? events.at(-1)!.sequence : headSequence,
        hasMore,
      };
    }
    const commandId = CommandId.make(`${prefix}-${digest(request.commandId)}`);
    const { id: _id, ...content } = request;
    const payload = canonical(content);
    if (request.operation === "approve") {
      const prior = yield* sql<{
        command_id: string;
      }>`SELECT command_id FROM sift_bridge_commands WHERE command_id = ${commandId}`;
      // A new command for a request that another client already answered must
      // not reach the provider twice. Retries of the original command skip this
      // check so they replay its receipt. The approval projection commits in the
      // same transaction as each dispatch, so a recorded response is visible here.
      if (prior.length === 0) {
        const approvals = yield* sql<{
          thread_id: string;
          status: string;
          decision: string | null;
        }>`SELECT thread_id, status, decision FROM projection_pending_approvals WHERE request_id = ${request.requestId}`;
        const approval = approvals[0];
        if (!approval || approval.thread_id !== threadId)
          return yield* fail("UNKNOWN_REQUEST", "No approval request with this ID is open here.");
        if (approval.status === "resolved")
          return { threadId, state: "already_resolved", decision: approval.decision };
      }
    }
    const createdAt = yield* nowIso;
    yield* sql`INSERT INTO sift_bridge_commands (command_id, payload, created_at) VALUES (${commandId}, ${payload}, ${createdAt}) ON CONFLICT(command_id) DO NOTHING`;
    const receipts = yield* sql<{
      payload: string;
      created_at: string;
    }>`SELECT payload, created_at FROM sift_bridge_commands WHERE command_id = ${commandId}`;
    const stored = receipts[0]!;
    if (stored.payload !== payload)
      return yield* fail(
        "COMMAND_CONFLICT",
        "Command identity was already used with a different payload.",
      );
    const base = { commandId, threadId, createdAt: stored.created_at };
    let command: OrchestrationCommand;
    switch (request.operation) {
      case "turn":
        command = {
          ...base,
          type: "thread.turn.start",
          message: {
            messageId: MessageId.make(commandId),
            role: "user",
            text: request.text,
            attachments: [],
          },
          runtimeMode: binding.runtimeMode,
          interactionMode: "default",
        };
        break;
      case "stop":
        command = { ...base, type: "thread.session.stop" };
        break;
      case "interrupt":
        command = { ...base, type: "thread.turn.interrupt" };
        break;
      case "approve":
        command = {
          ...base,
          type: "thread.approval.respond",
          requestId: ApprovalRequestId.make(request.requestId),
          decision: request.decision,
        };
        break;
      case "answer":
        command = {
          ...base,
          type: "thread.user-input.respond",
          requestId: ApprovalRequestId.make(request.requestId),
          answers: request.answers,
        };
        break;
    }
    const receipt = yield* dispatch(command);
    return { threadId, state: "accepted", sequence: receipt.sequence };
  }, mutex.withPermit);

  return Effect.fn("SiftBridge.handle")(function* (input: unknown, authorize?: () => void) {
    const request = yield* decodeRequest(input, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => fail("INVALID_REQUEST", "Invalid bridge request.")));
    return yield* execute(request, authorize).pipe(
      Effect.map((result) => ({ id: request.id, ok: true as const, result })),
      Effect.catch((error) =>
        Effect.succeed({
          id: request.id,
          ok: false as const,
          error: isBridgeError(error)
            ? { code: error.code, message: error.message }
            : {
                code: "COMMAND_FAILED",
                message: "The operation failed; inspect local runtime diagnostics.",
              },
        }),
      ),
    );
  });
});
