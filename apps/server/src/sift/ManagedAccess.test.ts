// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ThreadId,
  WS_METHODS,
  type AuthSessionId,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import { ServerConfig } from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { makeSiftBridge } from "./Bridge.ts";
import {
  MANAGED_ACCESS_ENV,
  assignmentIds,
  authorizeManagedRpc,
  encodeManagedSubject,
  guardRpcHandlers,
  makeHttpGate,
  makeRpcGuard,
  parseManagedSubject,
  type ManagedAttempt,
} from "./ManagedAccess.ts";

const modelSelection = { instanceId: "codex", model: "gpt-5.4" } as const;
const binding = { runtimeId: "runtime-1", workItemId: "work-1", leaseGeneration: 1 };
const request = { id: "request-1", binding };
const { threadId } = assignmentIds(binding);

const tempDirectory = (prefix: string) =>
  Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix))),
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  );

// Managed mode is read from the environment when services are built.
const managedMode = (enabled: boolean) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env[MANAGED_ACCESS_ENV];
      if (enabled) process.env[MANAGED_ACCESS_ENV] = "1";
      else delete process.env[MANAGED_ACCESS_ENV];
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[MANAGED_ACCESS_ENV];
        else process.env[MANAGED_ACCESS_ENV] = previous;
      }),
  );

const testLayer = (directory: string) =>
  EnvironmentAuth.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.identityLayer),
    Layer.provideMerge(
      OrchestrationLayerLive.pipe(
        Layer.provide(ThreadPlanProgress.layer),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provideMerge(makeSqlitePersistenceLive(NodePath.join(directory, "state.sqlite"))),
        Layer.provideMerge(ServerConfig.layerTest(directory, { prefix: "sift-managed-test-" })),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

const httpRequest = (token: string, method: string, url: string) =>
  ({
    cookies: {},
    headers: { authorization: `Bearer ${token}` },
    method,
    url,
  }) as unknown as HttpServerRequest.HttpServerRequest;

const requestMetadata = { deviceType: "desktop" as const, os: "macOS", browser: "Chrome" };

const bindAndAttach = (checkout: string, role: "reviewer" | "operator", ttlSeconds = 600) =>
  Effect.gen(function* () {
    const handle = yield* makeSiftBridge;
    const bound = yield* handle({
      ...request,
      operation: "bind",
      checkoutPath: checkout,
      modelSelection,
      runtimeMode: "approval-required",
    });
    expect(bound.ok).toBe(true);
    const attached = yield* handle({ ...request, operation: "attach", role, ttlSeconds });
    if (!attached.ok || !("credential" in attached.result)) throw new Error("Attach failed");
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const token = yield* auth.exchangeBootstrapCredentialForAccessToken(
      attached.result.credential,
      undefined,
      requestMetadata,
    );
    const session = yield* auth.authenticateHttpRequest(
      httpRequest(token.access_token, "GET", "/api/auth/session"),
    );
    return { handle, auth, token: token.access_token, session, attached: attached.result };
  });

const turnStart = (overrides: Record<string, unknown> = {}) => ({
  type: "thread.turn.start",
  commandId: "command-1",
  threadId,
  message: { messageId: "message-1", role: "user", text: "Continue.", attachments: [] },
  runtimeMode: "approval-required",
  interactionMode: "default",
  createdAt: "2026-09-23T00:00:00.000Z",
  ...overrides,
});

it("encodes the attempt, role, and deadline in a strict subject", () => {
  const subject = encodeManagedSubject({
    role: "operator",
    attemptKey: "a".repeat(64),
    notAfterMs: 1_000,
  });
  expect(parseManagedSubject(subject)).toEqual({
    role: "operator",
    attemptKey: "a".repeat(64),
    notAfterMs: 1_000,
  });
  for (const forged of [
    "one-time-token",
    `${subject}:extra`,
    subject.replace("operator", "admin"),
    subject.replace(":1000", ":0"),
  ])
    expect(parseManagedSubject(forged)).toBeUndefined();
});

it.effect("confines each role to its methods, the bound thread, and the checkout", () =>
  Effect.gen(function* () {
    const root = yield* tempDirectory("sift-managed-policy-");
    const outside = yield* tempDirectory("sift-managed-outside-");
    const checkout = yield* Effect.promise(async () => {
      const checkout = await NodeFSP.realpath(NodePath.join(root));
      await NodeFSP.writeFile(NodePath.join(checkout, "inside.txt"), "ok");
      await NodeFSP.writeFile(NodePath.join(outside, "secret.txt"), "no");
      await NodeFSP.symlink(NodePath.join(outside, "secret.txt"), NodePath.join(checkout, "link"));
      return checkout;
    });
    const attempt: ManagedAttempt = {
      attemptKey: "a".repeat(64),
      threadId,
      projectId: ProjectId.make(threadId),
      checkoutPath: checkout,
      // Same shape as the decoded value; the instance id brand is type-level only.
      modelSelection: modelSelection as unknown as ManagedAttempt["modelSelection"],
      runtimeMode: "approval-required",
    };
    const check = (role: "reviewer" | "operator", method: string, payload: unknown = {}) =>
      authorizeManagedRpc(role, attempt, method, payload).pipe(
        Effect.exit,
        Effect.map(Exit.isSuccess),
      );

    // Administration, terminals, and environment-wide reads fail for both roles.
    for (const role of ["reviewer", "operator"] as const) {
      for (const method of [
        WS_METHODS.terminalOpen,
        WS_METHODS.terminalWrite,
        WS_METHODS.providerInstallStart,
        WS_METHODS.providerAuthStart,
        WS_METHODS.serverUpdateProvider,
        WS_METHODS.serverUpdateSettings,
        WS_METHODS.serverGetSettings,
        WS_METHODS.serverSignalProcess,
        WS_METHODS.projectsWriteFile,
        WS_METHODS.filesystemBrowse,
        WS_METHODS.vcsCreateWorktree,
        WS_METHODS.projectCloneStart,
        WS_METHODS.deviceList,
        WS_METHODS.subscribeAuthAccess,
        ORCHESTRATION_WS_METHODS.searchThreads,
        "server.notRegistered",
      ])
        expect(yield* check(role, method, { cwd: checkout })).toBe(false);
      expect(yield* check(role, ORCHESTRATION_WS_METHODS.subscribeThread, { threadId })).toBe(true);
      expect(
        yield* check(role, ORCHESTRATION_WS_METHODS.subscribeThread, {
          threadId: ThreadId.make("another-thread"),
        }),
      ).toBe(false);
      expect(
        yield* check(role, WS_METHODS.projectsReadFile, {
          cwd: checkout,
          relativePath: "inside.txt",
        }),
      ).toBe(true);
      for (const relativePath of [NodePath.join(outside, "secret.txt"), "../secret.txt", "link"])
        expect(
          yield* check(role, WS_METHODS.projectsReadFile, { cwd: checkout, relativePath }),
        ).toBe(false);
      expect(yield* check(role, WS_METHODS.projectsSearchContents, { cwd: outside })).toBe(false);
      expect(yield* check(role, WS_METHODS.reviewGetDiffPreview, { cwd: checkout })).toBe(true);
      expect(
        yield* check(role, WS_METHODS.reviewGetDiffFileContents, {
          cwd: checkout,
          oldPath: "../x",
          newPath: "x",
        }),
      ).toBe(false);
    }

    // Reviewers never dispatch; operators dispatch only live control of the bound thread.
    const dispatch = ORCHESTRATION_WS_METHODS.dispatchCommand;
    expect(yield* check("reviewer", dispatch, turnStart())).toBe(false);
    expect(yield* check("operator", dispatch, turnStart())).toBe(true);
    expect(yield* check("operator", dispatch, turnStart({ modelSelection }))).toBe(true);
    for (const command of [
      { type: "thread.turn.interrupt", threadId },
      { type: "thread.approval.respond", threadId, requestId: "r", decision: "accept" },
      { type: "thread.user-input.respond", threadId, requestId: "r", answers: {} },
      { type: "thread.session.stop", threadId },
    ])
      expect(yield* check("operator", dispatch, command)).toBe(true);
    for (const command of [
      { type: "project.create", projectId: "p", workspaceRoot: "/" },
      { type: "thread.create", threadId: "new-thread" },
      { type: "thread.runtime-mode.set", threadId, runtimeMode: "full-access" },
      { type: "thread.checkpoint.revert", threadId, turnCount: 0 },
      { type: "thread.turn.interrupt", threadId: "another-thread" },
      turnStart({ runtimeMode: "full-access" }),
      turnStart({ modelSelection: { instanceId: "codex", model: "other" } }),
      turnStart({ bootstrap: { createThread: {} } }),
      turnStart({ threadId: "another-thread" }),
      turnStart({
        message: {
          messageId: "m",
          role: "user",
          text: "x",
          attachments: [{ type: "image", id: "a" }],
        },
      }),
    ])
      expect(yield* check("operator", dispatch, command)).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("leaves normal authentication and RPC handlers untouched outside managed mode", () =>
  Effect.gen(function* () {
    yield* managedMode(false);
    const directory = yield* tempDirectory("sift-unmanaged-");
    yield* Effect.gen(function* () {
      expect(yield* makeHttpGate).toBeUndefined();
      const guard = yield* makeRpcGuard({
        sessionId: "session" as AuthSessionId,
        subject: "one-time-token",
      });
      expect(guard).toBeUndefined();
      const handlers = { method: () => Effect.void };
      expect(guardRpcHandlers(guard, handlers)).toBe(handlers);

      // Attach refuses to mint credentials the server would not confine.
      const handle = yield* makeSiftBridge;
      yield* handle({
        ...request,
        operation: "bind",
        checkoutPath: directory,
        modelSelection,
        runtimeMode: "approval-required",
      });
      const attached = yield* handle({
        ...request,
        operation: "attach",
        role: "reviewer",
        ttlSeconds: 60,
      });
      expect(!attached.ok && attached.error.code).toBe("MANAGED_ACCESS_DISABLED");

      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const issued = yield* auth.issueSession({ subject: "cli-issued-session" });
      const session = yield* auth.authenticateHttpRequest(
        httpRequest(issued.token, "GET", "/api/orchestration/snapshot"),
      );
      expect(session.subject).toBe("cli-issued-session");
    }).pipe(Effect.provide(testLayer(directory)));
  }).pipe(Effect.scoped),
);

it.effect("admits only attempt-scoped credentials to allowed routes in managed mode", () =>
  Effect.gen(function* () {
    yield* managedMode(true);
    const directory = yield* tempDirectory("sift-managed-http-");
    yield* Effect.gen(function* () {
      const { auth, token, session, attached } = yield* bindAndAttach(directory, "reviewer");
      expect(attached.scopes).toEqual(["orchestration:read", "review:write"]);
      expect(parseManagedSubject(session.subject)?.role).toBe("reviewer");

      const allowed = (method: string, url: string) =>
        auth
          .authenticateHttpRequest(httpRequest(token, method, url))
          .pipe(Effect.exit, Effect.map(Exit.isSuccess));
      expect(yield* allowed("POST", "/api/auth/websocket-ticket")).toBe(true);
      expect(yield* allowed("GET", `/api/orchestration/threads/${threadId}`)).toBe(true);
      expect(yield* allowed("GET", "/api/orchestration/threads/another-thread")).toBe(false);
      expect(yield* allowed("GET", "/api/orchestration/snapshot")).toBe(false);
      expect(yield* allowed("POST", "/api/orchestration/dispatch")).toBe(false);
      expect(yield* allowed("GET", "/api/auth/clients")).toBe(false);

      // An ordinary administrative session cannot use a managed environment.
      const admin = yield* auth.issueSession();
      const adminExit = yield* auth
        .authenticateHttpRequest(httpRequest(admin.token, "GET", "/api/auth/session"))
        .pipe(Effect.exit);
      expect(Exit.isFailure(adminExit)).toBe(true);
      const adminGuard = yield* makeRpcGuard({
        sessionId: admin.sessionId,
        subject: admin.subject,
      });
      const adminRpc = yield* adminGuard!
        .authorize(WS_METHODS.serverGetConfig, {})
        .pipe(Effect.exit);
      expect(Exit.isFailure(adminRpc)).toBe(true);
    }).pipe(Effect.provide(testLayer(directory)));
  }).pipe(Effect.scoped),
);

it.effect("rejects managed RPCs after expiry, detach, and rebind", () =>
  Effect.gen(function* () {
    yield* managedMode(true);
    const directory = yield* tempDirectory("sift-managed-rpc-");
    yield* Effect.gen(function* () {
      const { handle, session } = yield* bindAndAttach(directory, "operator", 60);
      const guard = (yield* makeRpcGuard(session))!;
      const allowed = (method: string, payload: unknown) =>
        guard.authorize(method, payload).pipe(Effect.exit, Effect.map(Exit.isSuccess));

      expect(yield* allowed(ORCHESTRATION_WS_METHODS.dispatchCommand, turnStart())).toBe(true);
      expect(yield* allowed(WS_METHODS.terminalOpen, { threadId })).toBe(false);
      expect(yield* allowed(WS_METHODS.providerInstallStart, {})).toBe(false);

      // The deadline in the subject ends access even though the session row is valid.
      yield* TestClock.adjust("61 seconds");
      expect(yield* allowed(ORCHESTRATION_WS_METHODS.subscribeThread, { threadId })).toBe(false);

      // A fresh credential works until the host detaches, and detach ends live streams.
      const fresh = yield* bindAndAttach(directory, "reviewer");
      const freshGuard = (yield* makeRpcGuard(fresh.session))!;
      const handlers = guardRpcHandlers(freshGuard, {
        [ORCHESTRATION_WS_METHODS.subscribeThread]: (_payload: unknown) =>
          Stream.concat(Stream.make("snapshot"), Stream.never),
      });
      const subscribed = yield* Deferred.make<void>();
      const live = yield* handlers[ORCHESTRATION_WS_METHODS.subscribeThread]({ threadId }).pipe(
        Stream.runForEach(() => Deferred.succeed(subscribed, undefined)),
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      const detached = yield* handle({ ...request, operation: "detach" });
      expect(detached.ok && detached.result).toMatchObject({ revokedSessions: 2 });
      yield* Fiber.join(live);
      expect(
        yield* freshGuard
          .authorize(ORCHESTRATION_WS_METHODS.subscribeThread, { threadId })
          .pipe(Effect.exit, Effect.map(Exit.isSuccess)),
      ).toBe(false);

      // Credentials never carry over to the next lease generation.
      const third = yield* bindAndAttach(directory, "reviewer");
      const rebound = yield* handle({
        id: "rebind",
        binding: { ...binding, leaseGeneration: 2 },
        operation: "bind",
        checkoutPath: directory,
        modelSelection,
        runtimeMode: "approval-required",
        expectedPreviousGeneration: 1,
      });
      expect(rebound.ok).toBe(true);
      const thirdGuard = (yield* makeRpcGuard(third.session))!;
      expect(
        yield* thirdGuard
          .authorize(ORCHESTRATION_WS_METHODS.subscribeThread, { threadId })
          .pipe(Effect.exit, Effect.map(Exit.isSuccess)),
      ).toBe(false);
      const staleAttach = yield* handle({
        ...request,
        operation: "attach",
        role: "operator",
        ttlSeconds: 60,
      });
      expect(!staleAttach.ok && staleAttach.error.code).toBe("BINDING_CONFLICT");
    }).pipe(Effect.provide(testLayer(directory)));
  }).pipe(Effect.scoped),
);
