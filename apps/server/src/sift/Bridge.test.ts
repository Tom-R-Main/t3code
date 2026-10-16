// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CommandId, EventId, ThreadId } from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { makeSiftBridge } from "./Bridge.ts";
import { WorkerBootstrap, burnWorkerBootstrap } from "./WorkerBootstrap.ts";
import { workerBootstrapFixture } from "../provider/testUtils/workerBootstrapFixture.ts";

const testLayer = (directory: string) =>
  OrchestrationLayerLive.pipe(
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(makeSqlitePersistenceLive(NodePath.join(directory, "state.sqlite"))),
    Layer.provideMerge(ServerConfig.layerTest(directory, { prefix: "sift-bridge-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
const binding = { runtimeId: "runtime-1", workItemId: "work-1", leaseGeneration: 1 };
const request = { id: "request-1", binding };

it.effect("rejects authorization that expires while waiting for the bridge mutex", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sift-expiry-"))),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const blocked = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const handle = yield* makeSiftBridge.pipe(
        Effect.provideService(OrchestrationEngineService, {
          ...engine,
          dispatch: (command, options) =>
            command.type === "thread.turn.start" && command.message.text === "Hold the mutex."
              ? Deferred.succeed(blocked, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(engine.dispatch(command, options)),
                )
              : engine.dispatch(command, options),
        }),
      );
      yield* handle({
        ...request,
        operation: "bind",
        checkoutPath: directory,
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "approval-required",
      });
      const first = yield* handle({
        ...request,
        operation: "turn",
        commandId: "hold",
        text: "Hold the mutex.",
      }).pipe(Effect.forkChild);
      yield* Deferred.await(blocked);
      let expired = false;
      const second = yield* handle(
        { ...request, operation: "turn", commandId: "expired", text: "Must not execute." },
        () => {
          if (expired) throw new Error("Expired");
        },
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expired = true;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      const rejected = yield* Fiber.join(second);
      expect(!rejected.ok && rejected.error.code).toBe("AUTHORIZATION_FAILED");
      const events = yield* handle({ ...request, operation: "events", afterSequence: 0 });
      // @effect-diagnostics-next-line preferSchemaOverJson:off - substring check over the reply.
      expect(JSON.stringify(events)).not.toContain("Must not execute.");
    }).pipe(Effect.provide(testLayer(directory)));
  }).pipe(Effect.scoped),
);

it.effect("repairs a crash after generation CAS before accepting a turn", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sift-recovery-"))),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    yield* Effect.gen(function* () {
      const handle = yield* makeSiftBridge;
      yield* handle({
        ...request,
        operation: "bind",
        checkoutPath: directory,
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "approval-required",
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE sift_bridge_binding SET payload = json_set(payload, '$.binding.leaseGeneration', 2), ready_generation = 0 WHERE slot = 1`;
    }).pipe(Effect.provide(testLayer(directory)));
    yield* Effect.gen(function* () {
      const handle = yield* makeSiftBridge;
      const next = { ...request, binding: { ...binding, leaseGeneration: 2 } };
      const turn = yield* handle({
        ...next,
        operation: "turn",
        commandId: "recovered-turn",
        text: "Continue after recovery.",
      });
      expect(turn.ok).toBe(true);
      const replay = yield* handle({ ...next, operation: "events", afterSequence: 0 });
      if (!replay.ok || !("events" in replay.result)) throw new Error("Replay failed");
      const types = replay.result.events.map((event) => event.type);
      expect(types.indexOf("thread.session-stop-requested")).toBeGreaterThanOrEqual(0);
      expect(types.indexOf("thread.session-stop-requested")).toBeLessThan(
        types.indexOf("thread.turn-start-requested"),
      );
      const sql = yield* SqlClient.SqlClient;
      const ready = yield* sql<{
        ready_generation: number;
      }>`SELECT ready_generation FROM sift_bridge_binding WHERE slot = 1`;
      expect(ready[0]?.ready_generation).toBe(2);
    }).pipe(Effect.provide(testLayer(directory)));
  }).pipe(Effect.scoped),
);

it.effect(
  "persists identity, command receipts, replay and generation fencing across engine restart",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sift-bridge-"))),
        (directory) =>
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      );
      const bind = {
        ...request,
        operation: "bind",
        checkoutPath: directory,
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "approval-required",
      };
      const first = yield* Effect.gen(function* () {
        const handle = yield* makeSiftBridge;
        const accepted = yield* handle(bind);
        expect(accepted.ok).toBe(true);
        const turn = yield* handle({
          ...request,
          operation: "turn",
          commandId: "turn-1",
          text: "Inspect this workspace.",
        });
        expect(turn.ok).toBe(true);
        const replay = yield* handle({
          ...request,
          operation: "events",
          afterSequence: 0,
          limit: 1,
        });
        expect(replay.ok && "events" in replay.result && replay.result.events.length).toBe(1);
        expect(replay.ok && "hasMore" in replay.result && replay.result.hasMore).toBe(true);
        return { accepted, turn };
      }).pipe(Effect.provide(testLayer(directory)));
      yield* Effect.gen(function* () {
        const handle = yield* makeSiftBridge;
        expect(yield* handle({ ...bind, id: "retry" })).toEqual({ ...first.accepted, id: "retry" });
        expect(
          yield* handle({
            ...request,
            id: "retry-turn",
            operation: "turn",
            commandId: "turn-1",
            text: "Inspect this workspace.",
          }),
        ).toEqual({ ...first.turn, id: "retry-turn" });
        const conflict = yield* handle({
          ...request,
          operation: "turn",
          commandId: "turn-1",
          text: "Different action.",
        });
        expect(!conflict.ok && conflict.error.code).toBe("COMMAND_CONFLICT");
        const badBinding = yield* handle({ ...bind, binding: { ...binding, workItemId: "other" } });
        expect(!badBinding.ok && badBinding.error.code).toBe("BINDING_CONFLICT");
        const advanced = yield* handle({
          ...bind,
          binding: { ...binding, leaseGeneration: 2 },
          expectedPreviousGeneration: 1,
        });
        expect(advanced.ok && "threadId" in advanced.result && advanced.result.threadId).toBe(
          first.accepted.ok && "threadId" in first.accepted.result && first.accepted.result.threadId,
        );
        const old = yield* handle({ ...request, operation: "events", afterSequence: 0 });
        expect(!old.ok && old.error.code).toBe("BINDING_CONFLICT");
        const replay = yield* handle({
          ...request,
          binding: { ...binding, leaseGeneration: 2 },
          operation: "events",
          afterSequence: 0,
        });
        expect(
          replay.ok &&
            "events" in replay.result &&
            replay.result.events.filter((event) => event.type === "thread.turn-start-requested")
              .length,
        ).toBe(1);
        expect(
          replay.ok &&
            "events" in replay.result &&
            replay.result.events.some((event) => event.type === "thread.session-stop-requested"),
        ).toBe(true);
      }).pipe(Effect.provide(testLayer(directory)));
    }).pipe(Effect.scoped),
);

it.effect("bounds replay bytes without skipping an oversized event", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sift-bridge-"))),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    yield* Effect.gen(function* () {
      const handle = yield* makeSiftBridge;
      const engine = yield* OrchestrationEngineService;
      const bound = yield* handle({
        ...request,
        operation: "bind",
        checkoutPath: directory,
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "approval-required",
      });
      if (!bound.ok || !("threadId" in bound.result)) throw new Error("Binding failed.");
      const before = yield* engine.latestSequence;
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("huge-event"),
        threadId: ThreadId.make(bound.result.threadId),
        createdAt: "2026-01-01T00:00:00.000Z",
        activity: {
          id: EventId.make("huge-event"),
          kind: "provider.raw",
          summary: "Large event",
          tone: "info",
          turnId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          payload: { data: "x".repeat(600_000) },
        },
      });
      const result = yield* handle({ ...request, operation: "events", afterSequence: before });
      expect(!result.ok && result.error.code).toBe("EVENT_TOO_LARGE");
    }).pipe(Effect.provide(testLayer(directory)));
  }).pipe(Effect.scoped),
);

it.effect("resolves each approval request once across clients and restarts", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sift-approval-"))),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    yield* Effect.gen(function* () {
      const handle = yield* makeSiftBridge;
      const engine = yield* OrchestrationEngineService;
      const bound = yield* handle({
        ...request,
        operation: "bind",
        checkoutPath: directory,
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "approval-required",
      });
      if (!bound.ok || !("threadId" in bound.result)) throw new Error("Binding failed.");
      const threadId = ThreadId.make(bound.result.threadId);
      const appendActivity = (id: string, kind: string, payload: Record<string, unknown>) =>
        engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(id),
          threadId,
          createdAt: "2026-01-01T00:00:00.000Z",
          activity: {
            id: EventId.make(id),
            kind,
            summary: kind,
            tone: "approval",
            turnId: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            payload,
          },
        });
      yield* appendActivity("requested-1", "approval.requested", { requestId: "request-1" });
      const approve = (commandId: string, requestId: string, decision: string) =>
        handle({ ...request, operation: "approve", commandId, requestId, decision });

      const first = yield* approve("phone", "request-1", "accept");
      expect(first.ok && "state" in first.result && first.result.state).toBe("accepted");
      const second = yield* approve("browser", "request-1", "decline");
      expect(second.ok && second.result).toEqual({
        threadId,
        state: "already_resolved",
        decision: "accept",
      });
      expect(yield* approve("phone", "request-1", "accept")).toEqual(first);
      const replay = yield* handle({ ...request, operation: "events", afterSequence: 0 });
      if (!replay.ok || !("events" in replay.result)) throw new Error("Replay failed");
      expect(
        replay.result.events.filter((event) => event.type === "thread.approval-response-requested")
          .length,
      ).toBe(1);

      const scope = { version: 1, kind: "network", digest: "a".repeat(64) } as const;
      for (const invalid of [
        { expectedApprovalScope: scope, decision: "accept" },
        { feedback: "Try the fixture", decision: "decline" },
        { attemptId: "attempt", feedback: "Try the fixture", decision: "accept" },
        { attemptId: "attempt", ruleSourceRequestId: "source", decision: "accept" },
      ]) {
        const result = yield* handle({
          ...request,
          operation: "approve",
          commandId: "invalid",
          requestId: "request-1",
          ...invalid,
        });
        expect(!result.ok && result.error.code).toBe("INVALID_REQUEST");
      }
      yield* appendActivity("requested-scoped", "approval.requested", {
        requestId: "request-scoped",
      });
      const scoped = {
        ...request,
        operation: "approve",
        commandId: "scoped",
        requestId: "request-scoped",
        decision: "accept",
        attemptId: "attempt",
        expectedApprovalScope: scope,
        ruleSourceRequestId: "request-source",
      };
      expect((yield* handle(scoped)).ok).toBe(true);
      const changedScope = yield* handle({
        ...scoped,
        expectedApprovalScope: { ...scope, digest: "b".repeat(64) },
      });
      expect(!changedScope.ok && changedScope.error.code).toBe("COMMAND_CONFLICT");

      const unknown = yield* approve("unknown", "missing-request", "accept");
      expect(!unknown.ok && unknown.error.code).toBe("UNKNOWN_REQUEST");
      // Standing approvals stay a native-client decision; the socket replies
      // INVALID_REQUEST when decoding fails.
      const standing = yield* Effect.flip(approve("standing", "request-1", "acceptForSession"));
      expect(standing.code).toBe("INVALID_REQUEST");

      // Provider callbacks do not survive a T3 restart: the reactor then closes
      // the request as stale, and a later answer must not look answerable.
      yield* appendActivity("requested-2", "approval.requested", { requestId: "request-2" });
      yield* appendActivity("stale-2", "provider.approval.respond.failed", {
        requestId: "request-2",
        detail: "Stale pending approval request: request-2",
      });
      const stale = yield* approve("after-restart", "request-2", "accept");
      expect(stale.ok && stale.result).toEqual({
        threadId,
        state: "already_resolved",
        decision: null,
      });
    }).pipe(Effect.provide(testLayer(directory)));
  }).pipe(Effect.scoped),
);

it.effect(
  "terminalizes a guarded reservation when dispatch throws before persisting its event",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sift-approval-dispatch-fault-")),
        ),
        (directory) =>
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      );
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        let approvalDispatches = 0;
        const handle = yield* makeSiftBridge.pipe(
          Effect.provideService(OrchestrationEngineService, {
            ...engine,
            dispatch: (command, options) =>
              command.type === "thread.approval.respond"
                ? Effect.sync(() => {
                    approvalDispatches++;
                  }).pipe(Effect.andThen(Effect.die(new Error("Injected dispatch defect"))))
                : engine.dispatch(command, options),
          }),
        );
        const bound = yield* handle({
          ...request,
          operation: "bind",
          checkoutPath: directory,
          modelSelection: { instanceId: "codex", model: "gpt-5.4" },
          runtimeMode: "approval-required",
        });
        if (!bound.ok || !("threadId" in bound.result)) throw new Error("Binding failed");
        yield* engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make("fault-approval"),
          threadId: ThreadId.make(bound.result.threadId),
          createdAt: "2026-01-01T00:00:00.000Z",
          activity: {
            id: EventId.make("fault-approval"),
            kind: "approval.requested",
            summary: "Approval requested",
            tone: "approval",
            turnId: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            payload: { requestId: "fault-request" },
          },
        });
        const approve = {
          ...request,
          operation: "approve",
          commandId: "fault-decision",
          requestId: "fault-request",
          decision: "decline",
          attemptId: "attempt",
          feedback: "Use the existing fixture.",
        };
        const first = yield* handle(approve).pipe(Effect.exit);
        expect(first._tag).toBe("Failure");
        const retry = yield* handle(approve);
        expect(retry.ok && retry.result).toEqual({
          threadId: bound.result.threadId,
          state: "failed",
          error: "FEEDBACK_DELIVERY_UNKNOWN",
        });
        expect(approvalDispatches).toBe(1);
        const events = yield* handle({ ...request, operation: "events", afterSequence: 0 });
        if (!events.ok || !("events" in events.result)) throw new Error("Events unavailable");
        expect(
          events.result.events.some((event) => event.type === "thread.approval-response-requested"),
        ).toBe(false);
      }).pipe(Effect.provide(testLayer(directory)));
    }).pipe(Effect.scoped),
);

it.effect("forwards worker-policy inspection only to an exact ready assignment without dispatching a turn", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sift-worker-policy-"))),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const calls: Array<{ threadId: string; challenge: string; prepare: boolean }> = [];
      let expired = false;
      const attestation = { coverageComplete: false, configSha256: null, challenge: "fresh-challenge" };
      // The bridge reads only this optional private method. No startSession or
      // sendTurn implementation exists, so an accidental inference call fails.
      const inspection = {
        readWorkerPolicy: (threadId: ThreadId, challenge: string, prepare: boolean) =>
          Effect.sync(() => {
            calls.push({ threadId, challenge, prepare });
            if (challenge === "expire") expired = true;
            return { attestation, providerThreadId: "native-bound-thread" };
          }),
      } satisfies Pick<ProviderService["Service"], "readWorkerPolicy">;
      const handle = yield* makeSiftBridge.pipe(Effect.provide(Layer.mock(ProviderService)(inspection)));
      const unbound = yield* handle({ ...request, operation: "workerPolicy/read", threadId: "arbitrary", challenge: "fresh-challenge" });
      expect(!unbound.ok && unbound.error.code).toBe("NOT_BOUND");
      const bound = yield* handle({ ...request, operation: "bind", checkoutPath: directory,
        modelSelection: { instanceId: "codex", model: "gpt-5.4" }, runtimeMode: "approval-required" });
      if (!bound.ok || !("threadId" in bound.result)) throw new Error("Binding fixture failed");
      const threadId = bound.result.threadId;
      const beforeSequence = yield* engine.latestSequence;
      const input = { ...request, operation: "workerPolicy/read", threadId, challenge: "fresh-challenge", prepare: true };
      for (const changed of [
        { ...input, threadId: "arbitrary" },
        { ...input, binding: { ...binding, workItemId: "other-work" } },
        { ...input, challenge: "😀".repeat(65) },
        { ...input, challenge: "line\nbreak" },
      ]) expect((yield* handle(changed)).ok).toBe(false);
      expect(calls).toEqual([]);
      const response = yield* handle(input);
      expect(response.ok && response.result).toEqual({ attestation, providerThreadId: "native-bound-thread" });
      expect(calls).toEqual([{ threadId, challenge: "fresh-challenge", prepare: true }]);
      expect(yield* engine.latestSequence).toBe(beforeSequence);
      const expiredResponse = yield* handle({ ...input, challenge: "expire" }, () => {
        if (expired) throw new Error("Expired host signature");
      });
      expect(!expiredResponse.ok && expiredResponse.error.code).toBe("AUTHORIZATION_FAILED");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE sift_bridge_binding SET ready_generation = 0 WHERE slot = 1`;
      const notReady = yield* handle(input);
      expect(!notReady.ok && notReady.error.code).toBe("WORKER_POLICY_BINDING_MISMATCH");
      expect(calls).toHaveLength(2);
      expect(yield* engine.latestSequence).toBe(beforeSequence);
    }).pipe(Effect.provide(testLayer(directory)));
  }).pipe(Effect.scoped),
);

it.effect("starts a signed bound bootstrap without a turn or persisted payload and refuses retained-state replay", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sift-bootstrap-"))),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    const cwd = yield* Effect.promise(() => NodeFSP.realpath(directory));
    const fixture = workerBootstrapFixture(cwd);
    const keys = Object.keys(fixture.environment);
    const previous = keys.map((key) => [key, process.env[key]] as const);
    yield* Effect.acquireRelease(Effect.sync(() => Object.assign(process.env, fixture.environment)), () => Effect.sync(() => {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }));
    let calls = 0;
    let threadId: ThreadId | undefined;
    const bootstrapLayer = Layer.mock(ProviderService)({
      startSession: (id, input) => Effect.gen(function* () {
        calls++;
        const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
        if (Option.isNone(sql)) throw new Error("Fixture SQL missing");
        const burned = yield* sql.value<{ count: number }>`SELECT count(*) AS count FROM sift_worker_consumed_launches`.pipe(Effect.orDie);
        expect(burned[0]?.count).toBe(1);
        const capability = yield* Effect.serviceOption(WorkerBootstrap);
        if (Option.isNone(capability)) throw new Error("Fixture bootstrap capability missing");
        const bytes = yield* capability.value.consume({
          ...fixture.target, threadId: id, binaryPath: "/opt/sift/codex", homePath: undefined,
          environment: fixture.environment, launchArgs: undefined, appServerArgs: undefined, hasResumeCursor: false,
        }).pipe(Effect.orDie);
        bytes.fill(0);
        return { threadId: id, provider: "codex", status: "ready", runtimeMode: input.runtimeMode,
          cwd, createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:00Z" };
      }),
    });
    yield* Effect.gen(function* () {
      const handle = yield* makeSiftBridge;
      const bound = yield* handle({ ...request, operation: "bind", checkoutPath: cwd,
        modelSelection: { instanceId: "codex", model: "fixture-model" }, runtimeMode: "approval-required" });
      if (!bound.ok || !("threadId" in bound.result)) throw new Error("Fixture binding failed");
      threadId = bound.result.threadId;
      const input = { ...request, operation: "workerPolicy/bootstrap", threadId, materialization: fixture.materialization };
      expect((yield* handle(input)).ok).toBe(false);
      expect((yield* handle({ ...input, threadId: "other" }, () => {})).ok).toBe(false);
      const engine = yield* OrchestrationEngineService;
      const before = yield* engine.latestSequence;
      const result = yield* handle(input, () => {});
      expect(result.ok && result.result).toEqual({ threadId, state: "started" });
      expect(yield* engine.latestSequence).toBe(before);
      const sql = yield* SqlClient.SqlClient;
      expect((yield* sql`SELECT * FROM sift_bridge_commands`).length).toBe(0);
      const state = yield* sql`SELECT * FROM sift_bridge_binding`;
      expect(Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(state)).not.toContain(fixture.materialization.input.authorization);
    }).pipe(Effect.provide(bootstrapLayer), Effect.provide(testLayer(directory)));
    // Rebuild layers/bridge against the retained database, without carrying a
    // capability or payload forward from the previous in-memory bridge.
    yield* Effect.gen(function* () {
      const handle = yield* makeSiftBridge;
      const replay = yield* handle({ ...request, operation: "workerPolicy/bootstrap", threadId,
        materialization: fixture.materialization }, () => {});
      expect(replay.ok).toBe(false);
      expect(calls).toBe(1);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql`SELECT * FROM sift_worker_consumed_launches`;
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0]!).sort()).toEqual(["binding_sha256", "consumed_at", "incarnation_id", "launch_id", "thread_id"]);
      if (!threadId) throw new Error("Fixture bound thread missing");
      for (const identity of [
        { ...fixture.launch, launchId: "different-launch" },
        { ...fixture.launch, incarnationId: "different-incarnation" },
      ]) expect((yield* burnWorkerBootstrap(sql, { ...identity, threadId, consumedAt: "fixture" }).pipe(Effect.exit))._tag).toBe("Failure");
      expect((yield* sql`SELECT * FROM sift_worker_consumed_launches`).length).toBe(1);
    }).pipe(Effect.provide(bootstrapLayer), Effect.provide(testLayer(directory)));
  }).pipe(Effect.scoped),
);
