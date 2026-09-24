// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthReviewWriteScope,
  EnvironmentAuthorizationError,
  ModelSelection,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ThreadId,
  WS_METHODS,
  type AuthEnvironmentScope,
  type AuthSessionId,
} from "@t3tools/contracts";
import { SiftBinding } from "../../../../packages/contracts/src/siftBridge.ts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import { SessionStore } from "../auth/SessionStore.ts";

/**
 * Managed access is an opt-in posture for T3 environments that a Sift host
 * provisions for one assignment. When enabled, every authenticated HTTP request
 * and WebSocket RPC must come from a credential the host minted through the
 * bridge for the current attempt, and each role may use only a fixed set of
 * methods against the bound thread and checkout. Unset, nothing here runs.
 */
export const MANAGED_ACCESS_ENV = "T3_SIFT_MANAGED_ACCESS";
export const isManagedAccessEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env[MANAGED_ACCESS_ENV] === "1";

export const ManagedRole = Schema.Literals(["reviewer", "operator"]);
export type ManagedRole = typeof ManagedRole.Type;

export const MANAGED_ROLE_SCOPES: Readonly<
  Record<ManagedRole, ReadonlyArray<AuthEnvironmentScope>>
> = {
  reviewer: [AuthOrchestrationReadScope, AuthReviewWriteScope],
  operator: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope, AuthReviewWriteScope],
};

const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );

/** Thread and project ids the bridge derives for an assignment; stable across lease generations. */
export const assignmentIds = (binding: { runtimeId: string; workItemId: string }) => {
  const prefix = `sift-${digest(canonical({ runtimeId: binding.runtimeId, workItemId: binding.workItemId }))}`;
  return { threadId: ThreadId.make(prefix), projectId: ProjectId.make(prefix) };
};

/**
 * One attempt is one lease generation of one assignment. The access epoch
 * advances on every revocation, before any credential is revoked, so a session
 * redeemed from a pre-revocation link can never name the current attempt.
 */
export const attemptKey = (binding: typeof SiftBinding.Type, accessEpoch: number): string =>
  digest(
    canonical({
      runtimeId: binding.runtimeId,
      workItemId: binding.workItemId,
      leaseGeneration: binding.leaseGeneration,
      accessEpoch,
    }),
  );

export const ensureAccessEpochTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS sift_managed_access_epoch (slot INTEGER PRIMARY KEY CHECK (slot = 1), epoch INTEGER NOT NULL)`;
});

export const readAccessEpoch = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    epoch: number;
  }>`SELECT epoch FROM sift_managed_access_epoch WHERE slot = 1`;
  return rows[0]?.epoch ?? 0;
});

export const advanceAccessEpoch = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO sift_managed_access_epoch (slot, epoch) VALUES (1, 1) ON CONFLICT(slot) DO UPDATE SET epoch = epoch + 1`;
});

// The session subject is covered by the session token's signature, and pairing
// grants copy it into every session they create, so it carries the attempt and
// a hard deadline regardless of which client redeems the credential.
const SUBJECT_PREFIX = "sift-managed:v1";
export interface ManagedSubject {
  readonly role: ManagedRole;
  readonly attemptKey: string;
  readonly notAfterMs: number;
}
export const encodeManagedSubject = (subject: ManagedSubject): string =>
  `${SUBJECT_PREFIX}:${subject.role}:${subject.attemptKey}:${subject.notAfterMs}`;
export const parseManagedSubject = (subject: string): ManagedSubject | undefined => {
  const match = /^sift-managed:v1:(reviewer|operator):([0-9a-f]{64}):([1-9][0-9]{0,15})$/.exec(
    subject,
  );
  if (!match) return undefined;
  return {
    role: match[1] as ManagedRole,
    attemptKey: match[2]!,
    notAfterMs: Number(match[3]),
  };
};
export const isManagedSubject = (subject: string) => subject.startsWith(`${SUBJECT_PREFIX}:`);

export interface ManagedAttempt {
  readonly attemptKey: string;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly checkoutPath: string;
  readonly modelSelection: typeof ModelSelection.Type;
  readonly runtimeMode: "approval-required";
}

const StoredBinding = Schema.Struct({
  binding: SiftBinding,
  checkoutPath: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: Schema.Literal("approval-required"),
});
const decodeStoredBinding = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredBinding));

/** The ready attempt recorded by the bridge, or none while unbound or mid-rebind. */
export const readCurrentAttempt: Effect.Effect<
  Option.Option<ManagedAttempt>,
  never,
  SqlClient.SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    payload: string;
    ready_generation: number;
  }>`SELECT payload, ready_generation FROM sift_bridge_binding WHERE slot = 1`;
  const row = rows[0];
  if (!row) return Option.none<ManagedAttempt>();
  const stored = yield* decodeStoredBinding(row.payload);
  if (row.ready_generation !== stored.binding.leaseGeneration) return Option.none<ManagedAttempt>();
  const epoch = yield* readAccessEpoch;
  return Option.some({
    attemptKey: attemptKey(stored.binding, epoch),
    ...assignmentIds(stored.binding),
    checkoutPath: stored.checkoutPath,
    modelSelection: stored.modelSelection,
    runtimeMode: stored.runtimeMode,
  } satisfies ManagedAttempt);
}).pipe(
  // A missing bridge table or undecodable binding means nothing is attachable.
  Effect.catchCause(() => Effect.succeed(Option.none<ManagedAttempt>())),
);

type Denial = string;
const deny = (reason: Denial) => Effect.fail(reason);
const allow = Effect.void;

const isInside = (root: string, candidate: string) =>
  candidate === root ||
  candidate.startsWith(root.endsWith(NodePath.sep) ? root : root + NodePath.sep);

const realpathInside = (root: string, target: string) =>
  Effect.tryPromise(() => NodeFSP.realpath(target)).pipe(
    Effect.map((real) => isInside(root, real)),
    Effect.orElseSucceed(() => false),
  );

const requireWorkspaceCwd = (attempt: ManagedAttempt, cwd: unknown) =>
  typeof cwd === "string" && NodePath.isAbsolute(cwd)
    ? realpathInside(attempt.checkoutPath, cwd).pipe(
        Effect.flatMap((inside) =>
          inside ? allow : deny("cwd is outside the assignment checkout"),
        ),
      )
    : deny("cwd is outside the assignment checkout");

/** Repository-relative paths only; no absolute paths or parent traversal. */
const isRelativeInside = (path: unknown) => {
  if (typeof path !== "string" || path.length === 0) return false;
  if (NodePath.isAbsolute(path) || NodePath.win32.isAbsolute(path)) return false;
  const normalized = NodePath.normalize(path);
  return normalized !== ".." && !normalized.startsWith(`..${NodePath.sep}`);
};

const requireWorkspaceFile = (attempt: ManagedAttempt, cwd: unknown, path: unknown) =>
  requireWorkspaceCwd(attempt, cwd).pipe(
    Effect.andThen(
      isRelativeInside(path)
        ? realpathInside(
            attempt.checkoutPath,
            NodePath.resolve(cwd as string, path as string),
          ).pipe(
            Effect.flatMap((inside) =>
              inside ? allow : deny("path resolves outside the assignment checkout"),
            ),
          )
        : deny("path is outside the assignment checkout"),
    ),
  );

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
// Ambient GIT_* variables could point git at another repository.
const gitEnvironment = () =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));

/**
 * VCS services resolve the repository root from `cwd` and read the whole
 * repository from there, so a checkout nested in a larger repository would
 * expose changes outside it. Only the checkout itself is accepted, and only
 * when it is its own repository's top level.
 */
const requireRepositoryRoot = (attempt: ManagedAttempt, cwd: unknown) =>
  typeof cwd === "string" && NodePath.isAbsolute(cwd)
    ? Effect.tryPromise(async () => {
        if ((await NodeFSP.realpath(cwd)) !== attempt.checkoutPath) return false;
        const { stdout } = await execFile(
          "git",
          ["-C", attempt.checkoutPath, "rev-parse", "--show-toplevel"],
          { env: gitEnvironment(), timeout: 10_000 },
        );
        return (await NodeFSP.realpath(stdout.trim())) === attempt.checkoutPath;
      }).pipe(
        Effect.orElseSucceed(() => false),
        Effect.flatMap((isRoot) =>
          isRoot ? allow : deny("VCS access requires the checkout to be its repository root"),
        ),
      )
    : deny("cwd is outside the assignment checkout");

/**
 * Refs reach git as arguments before `--`, so anything git could read as an
 * option or a revision expression is refused: branch-like names and hashes only.
 */
const isPlainRef = (ref: string) =>
  ref.length <= 255 &&
  /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(ref) &&
  !ref.includes("..") &&
  !ref.includes("//") &&
  !ref.endsWith("/") &&
  !ref.endsWith(".") &&
  !ref.endsWith(".lock");

const requirePlainRefs = (...refs: ReadonlyArray<unknown>) =>
  refs.every(
    (ref) => ref === null || ref === undefined || (typeof ref === "string" && isPlainRef(ref)),
  )
    ? allow
    : deny("refs must be plain branch names or commit hashes");

const requireRelativePaths = (...paths: ReadonlyArray<unknown>) =>
  paths.every((path) => path === null || path === undefined || isRelativeInside(path))
    ? allow
    : deny("path is outside the assignment checkout");

const field = (payload: unknown, key: string): unknown =>
  payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>)[key]
    : undefined;

const requireBoundThread = (attempt: ManagedAttempt, payload: unknown) =>
  field(payload, "threadId") === attempt.threadId
    ? allow
    : deny("thread is outside the assignment");

const OPERATOR_COMMANDS: ReadonlySet<string> = new Set([
  "thread.turn.start",
  "thread.turn.interrupt",
  "thread.approval.respond",
  "thread.user-input.respond",
  "thread.user-input.dismiss",
  "thread.session.stop",
]);

const authorizeOperatorCommand = (attempt: ManagedAttempt, command: unknown) => {
  const type = field(command, "type");
  if (typeof type !== "string" || !OPERATOR_COMMANDS.has(type))
    return deny(`command ${String(type)} is not available to the operator role`);
  if (field(command, "threadId") !== attempt.threadId)
    return deny("thread is outside the assignment");
  if (type === "thread.turn.start") {
    const message = field(command, "message");
    const attachments = field(message, "attachments");
    if (field(command, "bootstrap") !== undefined)
      return deny("turns cannot create threads or worktrees");
    if (field(command, "sourceProposedPlan") !== undefined)
      return deny("turns cannot import plans from other threads");
    if (!Array.isArray(attachments) || attachments.length > 0)
      return deny("turns cannot carry attachments");
    if (field(command, "runtimeMode") !== attempt.runtimeMode)
      return deny("the permission mode is fixed by the assignment");
    const modelSelection = field(command, "modelSelection");
    if (
      modelSelection !== undefined &&
      canonical(modelSelection) !== canonical(attempt.modelSelection)
    )
      return deny("the model is fixed by the assignment");
  }
  if (type === "thread.user-input.respond") {
    const attachments = field(command, "attachmentsByQuestionId");
    if (attachments !== undefined && Object.keys(attachments as object).length > 0)
      return deny("answers cannot carry attachments");
  }
  return allow;
};

type RpcRule = (attempt: ManagedAttempt, payload: unknown) => Effect.Effect<void, Denial>;
const always: RpcRule = () => allow;
const boundThread: RpcRule = requireBoundThread;
const workspaceCwd: RpcRule = (attempt, payload) =>
  requireWorkspaceCwd(attempt, field(payload, "cwd"));
const repositoryRoot: RpcRule = (attempt, payload) =>
  requireRepositoryRoot(attempt, field(payload, "cwd"));

const REVIEWER_RULES: Readonly<Record<string, RpcRule>> = {
  [ORCHESTRATION_WS_METHODS.subscribeShell]: always,
  [ORCHESTRATION_WS_METHODS.subscribeThread]: boundThread,
  [ORCHESTRATION_WS_METHODS.getTurnDiff]: boundThread,
  [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: boundThread,
  [WS_METHODS.serverProbe]: always,
  [WS_METHODS.serverGetConfig]: always,
  [WS_METHODS.subscribeServerConfig]: always,
  [WS_METHODS.subscribeServerLifecycle]: always,
  [WS_METHODS.serverReportClientActivity]: always,
  [WS_METHODS.serverGetBackgroundPolicy]: always,
  [WS_METHODS.subscribeBackgroundPolicy]: always,
  [WS_METHODS.subscribeVcsStatus]: repositoryRoot,
  [WS_METHODS.vcsRefreshStatus]: repositoryRoot,
  [WS_METHODS.projectsSearchEntries]: workspaceCwd,
  [WS_METHODS.projectsSearchContents]: workspaceCwd,
  [WS_METHODS.projectsListEntries]: (attempt, payload) => {
    const directoryPath = field(payload, "directoryPath");
    return directoryPath === undefined || directoryPath === ""
      ? requireWorkspaceCwd(attempt, field(payload, "cwd"))
      : requireWorkspaceFile(attempt, field(payload, "cwd"), directoryPath);
  },
  [WS_METHODS.projectsReadFile]: (attempt, payload) =>
    requireWorkspaceFile(attempt, field(payload, "cwd"), field(payload, "relativePath")),
  [WS_METHODS.reviewGetDiffPreview]: (attempt, payload) => {
    const file = field(payload, "file");
    return requirePlainRefs(field(payload, "baseRef")).pipe(
      Effect.andThen(requireRelativePaths(field(file, "path"), field(file, "previousPath"))),
      Effect.andThen(requireRepositoryRoot(attempt, field(payload, "cwd"))),
    );
  },
  [WS_METHODS.reviewGetDiffFileContents]: (attempt, payload) =>
    requirePlainRefs(field(payload, "baseRef"), field(payload, "headRef")).pipe(
      Effect.andThen(requireRelativePaths(field(payload, "oldPath"), field(payload, "newPath"))),
      Effect.andThen(requireRepositoryRoot(attempt, field(payload, "cwd"))),
    ),
};

const OPERATOR_RULES: Readonly<Record<string, RpcRule>> = {
  ...REVIEWER_RULES,
  [ORCHESTRATION_WS_METHODS.dispatchCommand]: authorizeOperatorCommand,
};

/**
 * Default deny: an RPC absent from the role's table, including every RPC that
 * upstream adds later, is refused in managed mode.
 */
export const authorizeManagedRpc = (
  role: ManagedRole,
  attempt: ManagedAttempt,
  method: string,
  payload: unknown,
): Effect.Effect<void, Denial> => {
  const rules = role === "operator" ? OPERATOR_RULES : REVIEWER_RULES;
  const rule = Object.hasOwn(rules, method) ? rules[method] : undefined;
  return rule ? rule(attempt, payload) : deny(`${method} is not available to the ${role} role`);
};

interface ManagedSessionIdentity {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
}

/** Validates a session against managed mode: its subject, deadline, and the current attempt. */
const resolvePrincipal = (session: Pick<ManagedSessionIdentity, "subject">) =>
  Effect.gen(function* () {
    const subject = parseManagedSubject(session.subject);
    if (!subject) return yield* deny("managed mode accepts only Sift-issued credentials");
    if ((yield* Clock.currentTimeMillis) >= subject.notAfterMs)
      return yield* deny("the managed credential expired");
    const attempt = yield* readCurrentAttempt;
    if (Option.isNone(attempt) || attempt.value.attemptKey !== subject.attemptKey)
      return yield* deny("the credential belongs to a different attempt");
    return { role: subject.role, attempt: attempt.value, subject };
  });

// HTTP routes a managed session may reach; everything else is refused before
// its handler runs. The thread route is also limited to the bound thread.
const THREAD_SNAPSHOT_PATH = /^\/api\/orchestration\/threads\/([^/]+)$/;
const allowedHttpRoute = (attempt: ManagedAttempt, method: string, pathname: string) => {
  if (method === "GET" && (pathname === "/api/auth/session" || pathname === "/ws")) return true;
  if (method === "POST" && pathname === "/api/auth/websocket-ticket") return true;
  const thread = THREAD_SNAPSHOT_PATH.exec(pathname);
  if (method === "GET" && thread) {
    try {
      return decodeURIComponent(thread[1]!) === attempt.threadId;
    } catch {
      return false;
    }
  }
  return false;
};

/**
 * Returns undefined outside managed mode, so EnvironmentAuth is unchanged. In
 * managed mode, returns a check yielding a denial reason, or undefined to allow.
 */
export const makeHttpGate = Effect.gen(function* () {
  if (!isManagedAccessEnabled()) return undefined;
  const sql = yield* SqlClient.SqlClient;
  return (
    session: Pick<ManagedSessionIdentity, "subject">,
    route: { readonly method: string; readonly url: string },
  ): Effect.Effect<Denial | undefined> =>
    resolvePrincipal(session).pipe(
      Effect.flatMap(({ attempt }) => {
        let pathname: string;
        try {
          pathname = new URL(route.url, "http://managed.invalid").pathname;
        } catch {
          return deny("unrecognized route");
        }
        return allowedHttpRoute(attempt, route.method.toUpperCase(), pathname)
          ? Effect.succeed(undefined)
          : deny(`${route.method} ${pathname} is not available in managed mode`);
      }),
      Effect.catch((reason: Denial) => Effect.succeed(reason)),
      Effect.provideService(SqlClient.SqlClient, sql),
    );
});

export interface ManagedRpcGuard {
  readonly authorize: (
    method: string,
    payload: unknown,
  ) => Effect.Effect<void, EnvironmentAuthorizationError>;
  /** Completes when the session is revoked or its managed deadline passes. */
  readonly ended: Effect.Effect<void>;
}

const scopeForMethod = (method: string): AuthEnvironmentScope => {
  try {
    return requiredScopeForRpcMethod(method);
  } catch {
    return AuthOrchestrationOperateScope;
  }
};

/** Returns undefined outside managed mode, so the RPC layer is unchanged. */
export const makeRpcGuard = (session: ManagedSessionIdentity) =>
  Effect.gen(function* () {
    if (!isManagedAccessEnabled()) return undefined;
    const sql = yield* SqlClient.SqlClient;
    const sessions = yield* SessionStore;
    const revoked = yield* Deferred.make<void>();
    // Subscribe before the first RPC can run so a revocation cannot slip past.
    yield* sessions.streamChanges.pipe(
      Stream.filter(
        (change) => change.type === "clientRemoved" && change.sessionId === session.sessionId,
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.andThen(Deferred.succeed(revoked, undefined)),
      Effect.forkScoped({ startImmediately: true }),
    );
    const subject = parseManagedSubject(session.subject);
    const ended: Effect.Effect<void> = subject
      ? Effect.raceFirst(
          Deferred.await(revoked),
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) =>
              Effect.sleep(Duration.millis(Math.max(0, subject.notAfterMs - now))),
            ),
          ),
        )
      : Effect.void;
    const stillActive = sessions.listActive().pipe(
      Effect.map((active) => active.some((entry) => entry.sessionId === session.sessionId)),
      Effect.orElseSucceed(() => false),
    );
    const authorize = (method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (yield* Deferred.isDone(revoked))
          return yield* deny("the managed credential was revoked");
        const principal = yield* resolvePrincipal(session);
        if (!(yield* stillActive)) return yield* deny("the managed credential was revoked");
        yield* authorizeManagedRpc(principal.role, principal.attempt, method, payload);
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError(
          (reason) =>
            new EnvironmentAuthorizationError({
              message: `Managed access denied ${method}: ${reason}.`,
              requiredScope: scopeForMethod(method),
            }),
        ),
      );
    return { authorize, ended } satisfies ManagedRpcGuard;
  });

/**
 * Wraps every RPC handler with the managed guard. Streams also end when the
 * credential is revoked or expires. Without a guard, the handlers are returned
 * unchanged.
 */
export const guardRpcHandlers = <Handlers extends object>(
  guard: ManagedRpcGuard | undefined,
  handlers: Handlers,
): Handlers => {
  if (!guard) return handlers;
  const guardStream = (stream: Stream.Stream<unknown, unknown, unknown>) =>
    stream.pipe(Stream.interruptWhen(guard.ended));
  const guarded: Record<string, unknown> = {};
  for (const [method, handler] of Object.entries(handlers)) {
    guarded[method] = (payload: unknown, options: unknown) => {
      const result: unknown = (handler as (payload: unknown, options: unknown) => unknown)(
        payload,
        options,
      );
      if (Stream.isStream(result))
        return Stream.unwrap(guard.authorize(method, payload).pipe(Effect.as(guardStream(result))));
      // Checked without narrowing: the guard would type `result` as Effect<any, any, any>.
      if (Effect.isEffect(result as object))
        return guard.authorize(method, payload).pipe(
          Effect.andThen(result as Effect.Effect<unknown, EnvironmentAuthorizationError>),
          Effect.map((value) => (Stream.isStream(value) ? guardStream(value) : value)),
        );
      // Fail closed for any other handler shape: authorize before exposing it.
      return guard.authorize(method, payload).pipe(Effect.as(result));
    };
  }
  return guarded as Handlers;
};

/** Applies the managed guard to an RPC handler object as it is built. */
export const withRpcGuard =
  (session: ManagedSessionIdentity) =>
  <Handlers extends object, E, R>(build: Effect.Effect<Handlers, E, R>) =>
    Effect.gen(function* () {
      const handlers = yield* build;
      return guardRpcHandlers(yield* makeRpcGuard(session), handlers);
    });
