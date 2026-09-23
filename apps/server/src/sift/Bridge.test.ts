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
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CommandId, EventId, ThreadId } from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { makeSiftBridge } from "./Bridge.ts";

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
        expect(advanced.ok && advanced.result.threadId).toBe(
          first.accepted.ok && first.accepted.result.threadId,
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
      if (!bound.ok) throw new Error("Binding failed.");
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
      if (!bound.ok) throw new Error("Binding failed.");
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
      expect(first.ok && first.result.state).toBe("accepted");
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
