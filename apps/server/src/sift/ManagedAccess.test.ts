// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
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
import * as SessionStore from "../auth/SessionStore.ts";
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
  redirectingGitVariables,
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
    // Review diffs require the checkout to be its own repository root.
    git(checkout, "init", "-q");
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

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });

const policyAttempt = (checkoutPath: string): ManagedAttempt => ({
  attemptKey: "a".repeat(64),
  threadId,
  projectId: ProjectId.make(threadId),
  checkoutPath,
  // Same shape as the decoded value; the instance id brand is type-level only.
  modelSelection: modelSelection as unknown as ManagedAttempt["modelSelection"],
  runtimeMode: "approval-required",
});

it.effect("refuses VCS reads when the checkout is not its repository root", () =>
  Effect.gen(function* () {
    const outer = yield* tempDirectory("sift-managed-nested-");
    const repo = yield* Effect.promise(() => NodeFSP.realpath(outer));
    const checkout = NodePath.join(repo, "checkout");
    yield* Effect.promise(async () => {
      await NodeFSP.mkdir(checkout);
      await NodeFSP.writeFile(NodePath.join(checkout, "inside.txt"), "a");
      await NodeFSP.writeFile(NodePath.join(repo, "outside.txt"), "a");
    });
    git(repo, "init", "-q");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(repo, "outside.txt"), "secret"));
    const nested = policyAttempt(checkout);
    const allowed = (method: string, payload: unknown, attempt = nested) =>
      authorizeManagedRpc("reviewer", attempt, method, payload).pipe(
        Effect.exit,
        Effect.map(Exit.isSuccess),
      );
    for (const method of [
      WS_METHODS.reviewGetDiffPreview,
      WS_METHODS.subscribeVcsStatus,
      WS_METHODS.vcsRefreshStatus,
    ])
      expect(yield* allowed(method, { cwd: checkout })).toBe(false);
    expect(
      yield* allowed(WS_METHODS.reviewGetDiffFileContents, {
        cwd: checkout,
        sourceKind: "working-tree",
        changeType: "change",
        baseRef: null,
        headRef: null,
        oldPath: "inside.txt",
        newPath: "inside.txt",
      }),
    ).toBe(false);

    // A checkout that is its own repository root keeps review access.
    git(checkout, "init", "-q");
    const root = policyAttempt(checkout);
    expect(yield* allowed(WS_METHODS.reviewGetDiffPreview, { cwd: checkout }, root)).toBe(true);
    // Subdirectories of the root are refused: the diff service would widen to the root anyway.
    yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(checkout, "sub")));
    expect(
      yield* allowed(
        WS_METHODS.reviewGetDiffPreview,
        { cwd: NodePath.join(checkout, "sub") },
        root,
      ),
    ).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("refuses review refs that git could parse as options or revision expressions", () =>
  Effect.gen(function* () {
    const directory = yield* tempDirectory("sift-managed-refs-");
    const checkout = yield* Effect.promise(() => NodeFSP.realpath(directory));
    git(checkout, "init", "-q");
    const attempt = policyAttempt(checkout);
    const allowed = (method: string, payload: unknown) =>
      authorizeManagedRpc("reviewer", attempt, method, payload).pipe(
        Effect.exit,
        Effect.map(Exit.isSuccess),
      );
    const target = NodePath.join(checkout, "overwritten");
    for (const baseRef of [`--output=${target}`, "-p", "main..other", "HEAD@{1}", "a b", "x:y"]) {
      expect(yield* allowed(WS_METHODS.reviewGetDiffPreview, { cwd: checkout, baseRef })).toBe(
        false,
      );
      expect(
        yield* allowed(WS_METHODS.reviewGetDiffFileContents, {
          cwd: checkout,
          sourceKind: "branch-range",
          changeType: "change",
          baseRef: "main",
          headRef: baseRef,
          oldPath: "a",
          newPath: "a",
        }),
      ).toBe(false);
    }
    for (const baseRef of ["main", "origin/main", "release-1.2", "0123abcd"])
      expect(yield* allowed(WS_METHODS.reviewGetDiffPreview, { cwd: checkout, baseRef })).toBe(
        true,
      );
  }).pipe(Effect.scoped),
);

it.effect("rejects a session redeemed from a listed link while detach is revoking", () =>
  Effect.gen(function* () {
    yield* managedMode(true);
    const directory = yield* tempDirectory("sift-managed-race-");
    yield* Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const setup = yield* makeSiftBridge;
      yield* setup({
        ...request,
        operation: "bind",
        checkoutPath: directory,
        modelSelection,
        runtimeMode: "approval-required",
      });
      const attached = yield* setup({
        ...request,
        operation: "attach",
        role: "operator",
        ttlSeconds: 600,
      });
      if (!attached.ok || !("credential" in attached.result)) throw new Error("Attach failed");
      const credential = attached.result.credential;

      // Detach lists links, revokes them, then lists sessions. Model a client that
      // consumes a listed link before its revocation and whose session row lands
      // after the session list was read: the list it returns omits that session.
      const sessions = yield* SessionStore.SessionStore;
      let raced: { readonly token: string; readonly sessionId: string } | undefined;
      let redemptionAttempted = false;
      const racingAuth: typeof auth = {
        ...auth,
        listPairingLinks: (input) =>
          auth.listPairingLinks(input).pipe(
            Effect.tap(() =>
              auth
                .exchangeBootstrapCredentialForAccessToken(credential, undefined, requestMetadata)
                .pipe(
                  Effect.flatMap((token) =>
                    sessions.verify(token.access_token).pipe(
                      Effect.map((session) => {
                        raced = { token: token.access_token, sessionId: session.sessionId };
                      }),
                    ),
                  ),
                  // Refusing the redemption outright is also a correct outcome.
                  Effect.ignore,
                  Effect.ensuring(
                    Effect.sync(() => {
                      redemptionAttempted = true;
                    }),
                  ),
                ),
            ),
          ),
        listSessions: () =>
          auth
            .listSessions()
            .pipe(
              Effect.map((listed) =>
                listed.filter((session) => session.sessionId !== raced?.sessionId),
              ),
            ),
      };
      const handle = yield* makeSiftBridge.pipe(
        Effect.provideService(EnvironmentAuth.EnvironmentAuth, racingAuth),
      );
      const detached = yield* handle({ ...request, operation: "detach" });
      expect(detached.ok).toBe(true);
      expect(redemptionAttempted).toBe(true);
      if (raced !== undefined) {
        const session = yield* auth
          .authenticateHttpRequest(httpRequest(raced.token, "GET", "/api/auth/session"))
          .pipe(Effect.exit);
        expect(Exit.isFailure(session)).toBe(true);
      }
    }).pipe(Effect.provide(testLayer(directory)));
  }).pipe(Effect.scoped),
);

it.effect("accepts managed subjects only from sessions redeemed from a bridge attach", () =>
  Effect.gen(function* () {
    yield* managedMode(true);
    const directory = yield* tempDirectory("sift-managed-forged-");
    yield* Effect.gen(function* () {
      const { auth, token, session } = yield* bindAndAttach(directory, "reviewer", 60);
      const subject = parseManagedSubject(session.subject)!;
      const authenticates = (bearer: string) =>
        auth
          .authenticateHttpRequest(httpRequest(bearer, "GET", "/api/auth/session"))
          .pipe(Effect.exit, Effect.map(Exit.isSuccess));
      const rpcAllowed = (sessionId: AuthSessionId, forgedSubject: string) =>
        makeRpcGuard({ sessionId, subject: forgedSubject }).pipe(
          Effect.flatMap((guard) =>
            guard!.authorize(ORCHESTRATION_WS_METHODS.subscribeThread, { threadId }),
          ),
          Effect.exit,
          Effect.map(Exit.isSuccess),
        );

      // The bridge-issued session keeps working.
      expect(yield* authenticates(token)).toBe(true);
      expect(yield* rpcAllowed(session.sessionId, session.subject)).toBe(true);

      // The auth CLI can sign a session with any subject. Copy the attempt key,
      // escalate the role, and extend the deadline, or copy the subject verbatim.
      const escalated = encodeManagedSubject({
        role: "operator",
        attemptKey: subject.attemptKey,
        notAfterMs: subject.notAfterMs + 24 * 60 * 60 * 1000,
      });
      for (const forgedSubject of [escalated, session.subject]) {
        const forged = yield* auth.issueSession({
          subject: forgedSubject,
          scopes: ["orchestration:read", "orchestration:operate", "review:write"],
        });
        expect(yield* authenticates(forged.token)).toBe(false);
        expect(yield* rpcAllowed(forged.sessionId, forgedSubject)).toBe(false);

        // A pairing link minted outside the bridge cannot be redeemed into one either.
        const link = yield* auth.createPairingLink({
          subject: forgedSubject,
          scopes: ["orchestration:read", "orchestration:operate", "review:write"],
        });
        const redeemed = yield* auth
          .exchangeBootstrapCredentialForAccessToken(link.credential, undefined, requestMetadata)
          .pipe(Effect.exit);
        if (Exit.isSuccess(redeemed))
          expect(yield* authenticates(redeemed.value.access_token)).toBe(false);
      }
    }).pipe(Effect.provide(testLayer(directory)));
  }).pipe(Effect.scoped),
);

const withEnv = (key: string, value: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env[key];
      process.env[key] = value;
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }),
  );

it.effect("never lets a managed role reach VCS status, which can auto-pull the checkout", () =>
  Effect.gen(function* () {
    yield* managedMode(true);
    const directory = yield* tempDirectory("sift-managed-pull-");
    const base = yield* Effect.promise(() => NodeFSP.realpath(directory));
    const origin = NodePath.join(base, "origin");
    const checkout = NodePath.join(base, "checkout");
    yield* Effect.promise(() => NodeFSP.mkdir(origin));
    git(origin, "init", "-q", "-b", "main");
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(origin, "a.txt"), "1"));
    git(origin, "add", ".");
    git(origin, "commit", "-q", "-m", "one");
    git(base, "clone", "-q", origin, checkout);
    yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(origin, "a.txt"), "2"));
    git(origin, "commit", "-q", "-am", "two");
    git(checkout, "fetch", "-q");
    const head = () => git(checkout, "rev-parse", "HEAD").toString().trim();
    const before = head();

    yield* Effect.gen(function* () {
      for (const role of ["reviewer", "operator"] as const) {
        const { session } = yield* bindAndAttach(checkout, role);
        const guard = (yield* makeRpcGuard(session))!;
        // Stand-ins for the status handlers with auto-pull enabled: a behind,
        // clean default branch is fast-forwarded when status refreshes.
        const autoPull = () => {
          git(checkout, "pull", "-q", "--ff-only");
        };
        const handlers = guardRpcHandlers(guard, {
          [WS_METHODS.vcsRefreshStatus]: (_payload: unknown) => Effect.sync(autoPull),
          [WS_METHODS.subscribeVcsStatus]: (_payload: unknown) =>
            Stream.fromEffect(Effect.sync(autoPull)),
        });
        const refreshed = yield* handlers[WS_METHODS.vcsRefreshStatus]({ cwd: checkout }).pipe(
          Effect.exit,
        );
        const subscribed = yield* handlers[WS_METHODS.subscribeVcsStatus]({ cwd: checkout }).pipe(
          Stream.runDrain,
          Effect.exit,
        );
        expect(Exit.isFailure(refreshed)).toBe(true);
        expect(Exit.isFailure(subscribed)).toBe(true);
        expect(head()).toBe(before);
      }
    }).pipe(Effect.provide(testLayer(directory)));
  }).pipe(Effect.scoped),
);

it.effect("fails closed when the server environment redirects git", () =>
  Effect.gen(function* () {
    yield* managedMode(true);
    const directory = yield* tempDirectory("sift-managed-gitenv-");
    yield* Effect.gen(function* () {
      const { handle, token, auth } = yield* bindAndAttach(directory, "reviewer");
      yield* withEnv("GIT_DIR", NodePath.join(directory, "elsewhere.git"));
      // Startup refuses managed mode outright.
      expect(Exit.isFailure(yield* makeHttpGate.pipe(Effect.exit))).toBe(true);
      // An already-running server denies requests and refuses to mint credentials.
      const request_ = yield* auth
        .authenticateHttpRequest(httpRequest(token, "GET", "/api/auth/session"))
        .pipe(Effect.exit);
      expect(Exit.isFailure(request_)).toBe(true);
      const attached = yield* handle({
        ...request,
        operation: "attach",
        role: "reviewer",
        ttlSeconds: 60,
      });
      expect(!attached.ok && attached.error.code).toBe("MANAGED_ACCESS_UNSAFE_ENVIRONMENT");
    }).pipe(Effect.provide(testLayer(directory)));
  }).pipe(Effect.scoped),
);

it("detects injected configuration that moves the work tree", () => {
  expect(redirectingGitVariables({ GIT_WORK_TREE: "/elsewhere" })).toEqual(["GIT_WORK_TREE"]);
  expect(
    redirectingGitVariables({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.worktree" }),
  ).toEqual(["GIT_CONFIG_KEY_0"]);
  expect(redirectingGitVariables({ GIT_CONFIG_PARAMETERS: "'core.bare'='true'" })).toEqual([
    "GIT_CONFIG_PARAMETERS",
  ]);
  expect(
    redirectingGitVariables({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory" }),
  ).toEqual([]);
});
