// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId, type ProviderEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { assert, describe } from "vite-plus/test";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";
import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };

const ProcessRow = Schema.fromJsonString(
  Schema.Struct({ pid: Schema.Finite, kind: Schema.String, processId: Schema.String }),
);
const encodeScript = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeProcessRow = Schema.decodeUnknownEffect(ProcessRow);
const peerPath = NodePath.join(
  import.meta.dirname,
  `../testFixtures/codexCollabMockPeer.${HostProcessPlatform.defaultValue() === "win32" ? "cmd" : "sh"}`,
);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("managed interruption against owned fixture processes", () => {
  for (const mode of [
    "managed",
    "unmanaged",
    "unconfirmed",
    "admission-race",
    "missing-terminal",
    "pending-approval",
  ] as const) {
    it.live(`${mode}: preserves sibling and retained service, keeps the provider session`, () =>
      Effect.gen(function* () {
        const successful = mode === "managed" || mode === "pending-approval";
        const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "managed-interrupt-"));
        const scriptPath = NodePath.join(directory, "script.json");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
        );
        NodeFS.writeFileSync(
          scriptPath,
          yield* encodeScript({
            rootThreadId: wireFixture.rootThreadId,
            holdTurnOpen: true,
            turnIds: ["owned-turn", "next-turn"],
            notifications: [],
            managedCleanupError: mode === "unconfirmed" || mode === "admission-race",
            deferSecondReload: mode === "admission-race",
            missingTerminal: mode === "missing-terminal",
            cancelApprovalEndsTurn: mode === "pending-approval",
            serverRequests:
              mode === "pending-approval"
                ? [
                    {
                      method: "item/commandExecution/requestApproval",
                      label: "pending-command",
                      params: {
                        threadId: "${threadId}",
                        turnId: "${turnId}",
                        itemId: "pending-command",
                        startedAtMs: 1,
                        command: "pending fixture",
                        cwd: "/tmp",
                      },
                    },
                  ]
                : [],
            managedTerminals: [
              { kind: "owned", late: true },
              { kind: "retained" },
              { kind: "sibling", threadId: "sibling-thread" },
            ],
          }),
        );
        const runtime = yield* makeCodexSessionRuntime({
          threadId: ThreadId.make("managed-fixture"),
          binaryPath: peerPath,
          cwd: directory,
          runtimeMode: "full-access",
          managedInterrupt: mode !== "unmanaged",
          ...(mode === "admission-race"
            ? { appServerArgs: ["-c", 'mcp_servers.fixture.command="fixture"'] }
            : {}),
          environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
        });
        const ready = yield* Deferred.make<void>();
        const reloadBlocked = yield* Deferred.make<void>();
        const approvalReady = yield* Deferred.make<void>();
        const settled = yield* Deferred.make<void>();
        const events: ProviderEvent[] = [];
        yield* runtime.events.pipe(
          Stream.runForEach((event) => {
            events.push(event);
            if (event.method === "item/commandExecution/requestApproval")
              return Deferred.succeed(approvalReady, undefined);
            if (event.method === "serverRequest/resolved") {
              if ((event.payload as { requestId?: string }).requestId === "fixture-reload-blocked")
                return Deferred.succeed(reloadBlocked, undefined);
              return Deferred.succeed(ready, undefined);
            }
            if (
              event.method === "session/interrupt-unconfirmed" ||
              (event.method === "session/ready" &&
                events.some((e) => e.method === "turn/completed"))
            )
              return Deferred.succeed(settled, undefined);
            return Effect.void;
          }),
          Effect.forkScoped,
        );
        yield* runtime.start();
        yield* runtime.sendTurn({ input: "fixture" });
        yield* Deferred.await(ready).pipe(Effect.timeout("10 seconds"));
        const processes = yield* Effect.forEach(
          NodeFS.readFileSync(`${scriptPath}.processes`, "utf8").trim().split("\n"),
          (row) => decodeProcessRow(row),
        );
        assert.lengthOf(processes, 3);
        for (const p of processes) assert.isTrue(alive(p.pid));
        if (mode === "pending-approval")
          yield* Deferred.await(approvalReady).pipe(Effect.timeout("10 seconds"));
        const delayedTurn =
          mode === "admission-race"
            ? yield* runtime
                .sendTurn({ input: "racing follow-up" })
                .pipe(Effect.result, Effect.forkScoped)
            : undefined;
        if (delayedTurn) yield* Deferred.await(reloadBlocked).pipe(Effect.timeout("10 seconds"));
        yield* runtime.interruptTurn();
        if (mode === "pending-approval")
          assert.equal(
            NodeFS.readFileSync(`${scriptPath}.noActiveInterrupt`, "utf8"),
            "confirmed\n",
          );
        if (delayedTurn) {
          yield* runtime.uploadFeedback("release fixture reload");
          assert.equal((yield* Fiber.join(delayedTurn))._tag, "Failure");
          assert.equal(NodeFS.readFileSync(`${scriptPath}.turnStarts`, "utf8"), "start\n");
        }
        if (mode !== "unmanaged") yield* Deferred.await(settled).pipe(Effect.timeout("10 seconds"));
        assert.equal(
          alive(processes.find((p) => p.kind === "owned")!.pid),
          !successful,
          (yield* runtime.getSession).lastError,
        );
        assert.isTrue(alive(processes.find((p) => p.kind === "retained")!.pid));
        assert.isTrue(alive(processes.find((p) => p.kind === "sibling")!.pid));
        const before = NodeFS.readFileSync(`${scriptPath}.interrupts`, "utf8");
        yield* runtime.interruptTurn();
        assert.equal(NodeFS.readFileSync(`${scriptPath}.interrupts`, "utf8"), before);
        const session = yield* runtime.getSession;
        assert.equal(session.status, !successful && mode !== "unmanaged" ? "error" : "ready");
        if (!successful && mode !== "unmanaged") {
          assert.isFalse(events.some((e) => e.method === "turn/completed"));
          assert.isTrue(
            (yield* runtime.sendTurn({ input: "blocked" }).pipe(Effect.result))._tag === "Failure",
          );
        } else {
          const next = yield* runtime.sendTurn({ input: "continue" });
          assert.equal(next.turnId, "next-turn");
        }
        yield* runtime.close;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }
});

describe("managed admission across interruption and resume", () => {
  const writeScript = (directory: string, script: Record<string, unknown>) =>
    Effect.gen(function* () {
      const scriptPath = NodePath.join(directory, "script.json");
      NodeFS.writeFileSync(
        scriptPath,
        yield* encodeScript({
          rootThreadId: wireFixture.rootThreadId,
          holdTurnOpen: true,
          notifications: [],
          ...script,
        }),
      );
      return scriptPath;
    });

  it.live("a turn whose start response lands after interruption is interrupted and refused", () =>
    Effect.gen(function* () {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "managed-crossed-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const scriptPath = yield* writeScript(directory, {
        turnIds: ["owned-turn", "crossed-turn", "later-turn"],
        holdSecondTurnStart: true,
        managedTerminals: [{ kind: "owned" }],
      });
      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("managed-crossed"),
        binaryPath: peerPath,
        cwd: directory,
        runtimeMode: "full-access",
        managedInterrupt: true,
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const ready = yield* Deferred.make<void>();
      const held = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      const unconfirmed = yield* Deferred.make<void>();
      const events: ProviderEvent[] = [];
      yield* runtime.events.pipe(
        Stream.runForEach((event) => {
          events.push(event);
          if (event.method === "session/interrupt-unconfirmed")
            return Deferred.succeed(unconfirmed, undefined);
          if (event.method === "serverRequest/resolved") {
            const requestId = (event.payload as { requestId?: string }).requestId;
            return Deferred.succeed(
              requestId === "fixture-turn-start-held" ? held : ready,
              undefined,
            );
          }
          if (event.method === "session/ready" && events.some((e) => e.method === "turn/completed"))
            return Deferred.succeed(settled, undefined);
          return Effect.void;
        }),
        Effect.forkScoped,
      );
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "fixture" });
      yield* Deferred.await(ready).pipe(Effect.timeout("10 seconds"));
      const crossing = yield* runtime
        .sendTurn({ input: "follow-up in flight" })
        .pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(held).pipe(Effect.timeout("10 seconds"));
      yield* runtime.interruptTurn();
      yield* Deferred.await(settled).pipe(Effect.timeout("10 seconds"));
      yield* runtime.uploadFeedback("release held turn start");
      assert.equal((yield* Fiber.join(crossing))._tag, "Failure");
      const interrupts = NodeFS.readFileSync(`${scriptPath}.interrupts`, "utf8");
      assert.include(interrupts, '"turnId":"crossed-turn"');
      const session = yield* runtime.getSession;
      assert.equal(session.status, "error");
      yield* Deferred.await(unconfirmed).pipe(Effect.timeout("10 seconds"));
      assert.equal(
        (yield* runtime.sendTurn({ input: "blocked" }).pipe(Effect.result))._tag,
        "Failure",
      );
      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("an unconfirmed interruption stays unconfirmed after interrupting a queued turn", () =>
    Effect.gen(function* () {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "managed-sticky-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const scriptPath = yield* writeScript(directory, {
        turnIds: ["owned-turn", "queued-turn", "later-turn"],
        failFirstCleanupOnly: true,
        managedTerminals: [{ kind: "owned" }],
      });
      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("managed-sticky"),
        binaryPath: peerPath,
        cwd: directory,
        runtimeMode: "full-access",
        managedInterrupt: true,
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const ready = yield* Deferred.make<void>();
      const outcomes: string[] = [];
      const firstOutcome = yield* Deferred.make<void>();
      const secondOutcome = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => {
          if (event.method === "serverRequest/resolved") return Deferred.succeed(ready, undefined);
          const outcome =
            event.method === "session/interrupt-unconfirmed" ||
            (event.method === "session/ready" &&
              event.message !== "Codex App Server session ready.");
          if (outcome) {
            outcomes.push(event.method);
            return Deferred.succeed(
              outcomes.length === 1 ? firstOutcome : secondOutcome,
              undefined,
            );
          }
          return Effect.void;
        }),
        Effect.forkScoped,
      );
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "fixture" });
      yield* Deferred.await(ready).pipe(Effect.timeout("10 seconds"));
      const queued = yield* runtime.sendTurn({ input: "queued follow-up" });
      assert.equal(queued.turnId, "queued-turn");
      yield* runtime.interruptTurn("owned-turn" as never);
      yield* Deferred.await(firstOutcome).pipe(Effect.timeout("20 seconds"));
      assert.equal(outcomes[0], "session/interrupt-unconfirmed");
      yield* runtime.interruptTurn("queued-turn" as never);
      yield* Deferred.await(secondOutcome).pipe(Effect.timeout("20 seconds"));
      const session = yield* runtime.getSession;
      assert.equal(session.status, "error");
      assert.equal(
        (yield* runtime.sendTurn({ input: "blocked" }).pipe(Effect.result))._tag,
        "Failure",
      );
      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("a resumed managed session without process-tree attestation fails closed", () =>
    Effect.gen(function* () {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "managed-resume-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const scriptPath = yield* writeScript(directory, { turnIds: ["resumed-turn"] });
      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("managed-resume-unattested"),
        binaryPath: peerPath,
        cwd: directory,
        runtimeMode: "full-access",
        managedInterrupt: true,
        resumeCursor: { threadId: wireFixture.rootThreadId },
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const session = yield* runtime.start();
      assert.equal(session.status, "error");
      assert.include(session.lastError ?? "", "T3_SIFT_PRIOR_PROCESS_TREE_TERMINATED");
      assert.equal(
        (yield* runtime.sendTurn({ input: "after resume" }).pipe(Effect.result))._tag,
        "Failure",
      );
      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const variant of ["child-terminal", "loaded-list-error"] as const) {
    it.live(`a resumed managed session fails closed: ${variant}`, () =>
      Effect.gen(function* () {
        const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "managed-resume-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
        );
        const child = wireFixture.childThreadIds[0]!;
        const scriptPath = yield* writeScript(directory, {
          turnIds: ["resumed-turn"],
          loadedThreads: [wireFixture.rootThreadId, child],
          loadedListError: variant === "loaded-list-error",
          inheritedTerminals:
            variant === "child-terminal"
              ? [{ threadId: child, itemId: "child-command", processId: "42" }]
              : [],
        });
        const runtime = yield* makeCodexSessionRuntime({
          threadId: ThreadId.make("managed-resume-child"),
          binaryPath: peerPath,
          cwd: directory,
          runtimeMode: "full-access",
          managedInterrupt: true,
          resumeCursor: { threadId: wireFixture.rootThreadId },
          managedResumeAttested: true,
          environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
        });
        assert.equal((yield* runtime.start()).status, "error");
        assert.equal(
          (yield* runtime.sendTurn({ input: "after resume" }).pipe(Effect.result))._tag,
          "Failure",
        );
        yield* runtime.close;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.live(
    "a turn admitted after interruption is refused once an earlier in-flight turn crosses",
    () =>
      Effect.gen(function* () {
        const directory = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "managed-crossed-two-"),
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
        );
        const scriptPath = yield* writeScript(directory, {
          turnIds: ["owned-turn", "crossed-turn", "late-turn"],
          holdTurnStarts: [2, 3],
          managedTerminals: [{ kind: "owned" }],
        });
        const runtime = yield* makeCodexSessionRuntime({
          threadId: ThreadId.make("managed-crossed-two"),
          binaryPath: peerPath,
          cwd: directory,
          runtimeMode: "full-access",
          managedInterrupt: true,
          environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
        });
        const ready = yield* Deferred.make<void>();
        const heldSecond = yield* Deferred.make<void>();
        const heldThird = yield* Deferred.make<void>();
        const settled = yield* Deferred.make<void>();
        const events: ProviderEvent[] = [];
        yield* runtime.events.pipe(
          Stream.runForEach((event) => {
            events.push(event);
            if (event.method === "serverRequest/resolved") {
              const requestId = (event.payload as { requestId?: string }).requestId;
              if (requestId === "fixture-turn-start-held")
                return Deferred.succeed(heldSecond, undefined);
              if (requestId === "fixture-turn-start-held-3")
                return Deferred.succeed(heldThird, undefined);
              return Deferred.succeed(ready, undefined);
            }
            if (
              event.method === "session/ready" &&
              events.some((e) => e.method === "turn/completed")
            )
              return Deferred.succeed(settled, undefined);
            return Effect.void;
          }),
          Effect.forkScoped,
        );
        yield* runtime.start();
        yield* runtime.sendTurn({ input: "fixture" });
        yield* Deferred.await(ready).pipe(Effect.timeout("10 seconds"));
        const crossing = yield* runtime
          .sendTurn({ input: "in flight across the interrupt" })
          .pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(heldSecond).pipe(Effect.timeout("10 seconds"));
        yield* runtime.interruptTurn();
        yield* Deferred.await(settled).pipe(Effect.timeout("10 seconds"));
        // Admitted after the interrupt settled, still in flight when the first crosses.
        const late = yield* runtime
          .sendTurn({ input: "admitted after the interrupt" })
          .pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(heldThird).pipe(Effect.timeout("10 seconds"));
        yield* runtime.uploadFeedback("release crossed turn");
        assert.equal((yield* Fiber.join(crossing))._tag, "Failure");
        yield* runtime.uploadFeedback("release late turn");
        assert.equal((yield* Fiber.join(late))._tag, "Failure");
        const session = yield* runtime.getSession;
        assert.equal(session.status, "error");
        assert.include(
          NodeFS.readFileSync(`${scriptPath}.interrupts`, "utf8"),
          '"turnId":"late-turn"',
        );
        yield* runtime.close;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const inherited of [true, false]) {
    it.live(
      `a resumed managed session ${inherited ? "refuses" : "admits"} turns with ${inherited ? "inherited" : "no"} background terminals`,
      () =>
        Effect.gen(function* () {
          const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "managed-resume-"));
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
          );
          const scriptPath = yield* writeScript(directory, {
            turnIds: ["resumed-turn"],
            inheritedTerminals: inherited
              ? [{ threadId: wireFixture.rootThreadId, itemId: "earlier-command", processId: "41" }]
              : [],
          });
          const runtime = yield* makeCodexSessionRuntime({
            threadId: ThreadId.make("managed-resume"),
            binaryPath: peerPath,
            cwd: directory,
            runtimeMode: "full-access",
            managedInterrupt: true,
            resumeCursor: { threadId: wireFixture.rootThreadId },
            managedResumeAttested: true,
            environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
          });
          const session = yield* runtime.start();
          assert.equal(session.status, inherited ? "error" : "ready");
          const turn = yield* runtime.sendTurn({ input: "after resume" }).pipe(Effect.result);
          assert.equal(turn._tag, inherited ? "Failure" : "Success");
          yield* runtime.close;
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  for (const listing of ["works", "fails"] as const) {
    it.live(
      `closing a managed session terminates its terminals or taints the process: ${listing}`,
      () => {
        // runtime.close closes the scope it was built in, so the directory and any
        // surviving fixture processes are released outside it, after assertions.
        const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "managed-close-"));
        let spawned: ReadonlyArray<{ pid: number }> = [];
        return Effect.gen(function* () {
          const scriptPath = yield* writeScript(directory, {
            turnIds: ["owned-turn"],
            managedCleanupError: listing === "fails",
            managedTerminals: [{ kind: "owned" }, { kind: "retained" }],
          });
          let unconfirmedCloses = 0;
          const runtime = yield* makeCodexSessionRuntime({
            threadId: ThreadId.make("managed-close"),
            binaryPath: peerPath,
            cwd: directory,
            runtimeMode: "full-access",
            managedInterrupt: true,
            onManagedCloseUnconfirmed: () => {
              unconfirmedCloses++;
            },
            environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
          });
          const ready = yield* Deferred.make<void>();
          yield* runtime.events.pipe(
            Stream.runForEach((event) =>
              event.method === "serverRequest/resolved"
                ? Deferred.succeed(ready, undefined)
                : Effect.void,
            ),
            Effect.forkScoped,
          );
          yield* runtime.start();
          yield* runtime.sendTurn({ input: "fixture" });
          yield* Deferred.await(ready).pipe(Effect.timeout("10 seconds"));
          const processes = yield* Effect.forEach(
            NodeFS.readFileSync(`${scriptPath}.processes`, "utf8").trim().split("\n"),
            (row) => decodeProcessRow(row),
          );
          spawned = processes;
          yield* runtime.close;
          if (listing === "works") {
            // Close asked Codex to terminate every terminal and got confirmation,
            // rather than relying on app-server teardown to take them down.
            assert.equal(unconfirmedCloses, 0);
            assert.deepEqual(
              NodeFS.readFileSync(`${scriptPath}.terminated`, "utf8").trim().split("\n").sort(),
              processes.map((p) => p.processId).sort(),
            );
          } else {
            assert.equal(unconfirmedCloses, 1);
          }
        }).pipe(
          Effect.scoped,
          Effect.provide(NodeServices.layer),
          Effect.ensuring(
            Effect.sync(() => {
              for (const p of spawned) if (alive(p.pid)) process.kill(p.pid, "SIGKILL");
              NodeFS.rmSync(directory, { recursive: true, force: true });
            }),
          ),
        );
      },
    );
  }

  for (const cursor of [false, true]) {
    it.live(
      `a tainted T3 process refuses later managed sessions: ${cursor ? "resumed" : "fresh"}`,
      () =>
        Effect.gen(function* () {
          const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "managed-taint-"));
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
          );
          const scriptPath = yield* writeScript(directory, { turnIds: ["turn"] });
          const runtime = yield* makeCodexSessionRuntime({
            threadId: ThreadId.make("managed-taint"),
            binaryPath: peerPath,
            cwd: directory,
            runtimeMode: "full-access",
            managedInterrupt: true,
            managedProcessTaint: () => true,
            ...(cursor
              ? {
                  resumeCursor: { threadId: wireFixture.rootThreadId },
                  managedResumeAttested: true,
                }
              : {}),
            environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
          });
          const session = yield* runtime.start();
          assert.equal(session.status, "error");
          assert.equal(
            (yield* runtime.sendTurn({ input: "blocked" }).pipe(Effect.result))._tag,
            "Failure",
          );
          assert.equal((yield* runtime.compactThread.pipe(Effect.result))._tag, "Failure");
          yield* runtime.close;
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  const managedFixture = (name: string, script: Record<string, unknown>, extra: object = {}) =>
    Effect.gen(function* () {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `managed-${name}-`));
      const scriptPath = yield* writeScript(directory, { recordLifecycle: true, ...script });
      let unconfirmedCloses = 0;
      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make(`managed-${name}`),
        binaryPath: peerPath,
        cwd: directory,
        runtimeMode: "full-access",
        managedInterrupt: true,
        onManagedCloseUnconfirmed: () => {
          unconfirmedCloses++;
        },
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
        ...extra,
      });
      const events: ProviderEvent[] = [];
      const ready = yield* Deferred.make<void>();
      const unconfirmed = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => {
          events.push(event);
          if (event.method === "session/interrupt-unconfirmed")
            return Deferred.succeed(unconfirmed, undefined);
          if (event.method === "serverRequest/resolved") return Deferred.succeed(ready, undefined);
          return Effect.void;
        }),
        Effect.forkScoped,
      );
      return {
        directory,
        scriptPath,
        runtime,
        events,
        ready,
        unconfirmed,
        closes: () => unconfirmedCloses,
      };
    });
  const lifecycleOf = (scriptPath: string) =>
    NodeFS.existsSync(`${scriptPath}.lifecycle`)
      ? NodeFS.readFileSync(`${scriptPath}.lifecycle`, "utf8").trim().split("\n")
      : [];

  for (const interruptWorks of [true, false]) {
    it.live(
      `close settles an active turn before sweeping terminals: ${interruptWorks ? "settled" : "unsettled"}`,
      () => {
        let directory = "";
        return Effect.gen(function* () {
          const f = yield* managedFixture("close-active", {
            turnIds: ["owned-turn"],
            managedTerminals: [{ kind: "owned" }],
            ...(interruptWorks ? {} : { failInterruptFor: wireFixture.rootThreadId }),
          });
          directory = f.directory;
          yield* f.runtime.start();
          yield* f.runtime.sendTurn({ input: "fixture" });
          yield* Deferred.await(f.ready).pipe(Effect.timeout("10 seconds"));
          yield* f.runtime.close;
          const events = lifecycleOf(f.scriptPath);
          assert.equal(events[0], "interrupt:owned-turn");
          if (interruptWorks) {
            assert.equal(f.closes(), 0);
            assert.include(events, "terminate:1");
          } else {
            assert.equal(f.closes(), 1);
          }
        }).pipe(
          Effect.scoped,
          Effect.provide(NodeServices.layer),
          Effect.ensuring(
            Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
          ),
        );
      },
    );
  }

  it.live("observed unknown command ownership closes admission immediately", () => {
    let directory = "";
    return Effect.gen(function* () {
      const command = (processId: string) => ({
        method: "item/started",
        params: {
          threadId: wireFixture.rootThreadId,
          turnId: "owned-turn",
          startedAtMs: 1,
          item: {
            id: "conflicted",
            type: "commandExecution",
            command: "fixture",
            cwd: "/tmp",
            status: "inProgress",
            commandActions: [],
            processId,
          },
        },
      });
      const f = yield* managedFixture("ownership-unknown", {
        turnIds: ["owned-turn", "refused-turn"],
        notifications: [command("7"), command("8")],
      });
      directory = f.directory;
      yield* f.runtime.start();
      yield* f.runtime.sendTurn({ input: "fixture" });
      yield* Deferred.await(f.unconfirmed).pipe(Effect.timeout("10 seconds"));
      assert.equal((yield* f.runtime.getSession).status, "error");
      assert.equal(
        (yield* f.runtime.sendTurn({ input: "refused" }).pipe(Effect.result))._tag,
        "Failure",
      );
      yield* f.runtime.close;
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      ),
    );
  });

  for (const mode of ["error", "malformed"] as const) {
    it.live(`an accepted turn whose start response fails closes admission: ${mode}`, () => {
      let directory = "";
      return Effect.gen(function* () {
        const f = yield* managedFixture("start-failure", {
          turnIds: ["first-turn", "uncertain-turn"],
          failTurnStartResponse: { index: 2, mode },
        });
        directory = f.directory;
        yield* f.runtime.start();
        yield* f.runtime.sendTurn({ input: "first" });
        assert.equal(
          (yield* f.runtime.sendTurn({ input: "uncertain" }).pipe(Effect.result))._tag,
          "Failure",
        );
        yield* Deferred.await(f.unconfirmed).pipe(Effect.timeout("10 seconds"));
        assert.equal((yield* f.runtime.getSession).status, "error");
        assert.equal(
          (yield* f.runtime.sendTurn({ input: "refused" }).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.include(lifecycleOf(f.scriptPath), "interrupt:uncertain-turn");
        yield* f.runtime.close;
      }).pipe(
        Effect.scoped,
        Effect.provide(NodeServices.layer),
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
        ),
      );
    });
  }

  it.live("an approval that arrives after admission closed cannot be accepted", () => {
    let directory = "";
    return Effect.gen(function* () {
      const command = (processId: string) => ({
        method: "item/started",
        params: {
          threadId: wireFixture.rootThreadId,
          turnId: "owned-turn",
          startedAtMs: 1,
          item: {
            id: "conflicted",
            type: "commandExecution",
            command: "fixture",
            cwd: "/tmp",
            status: "inProgress",
            commandActions: [],
            processId,
          },
        },
      });
      const f = yield* managedFixture("approval-closed", {
        turnIds: ["owned-turn"],
        notifications: [command("7"), command("8")],
        serverRequests: [
          {
            method: "item/commandExecution/requestApproval",
            label: "late-approval",
            params: {
              threadId: "${threadId}",
              turnId: "${turnId}",
              itemId: "late-approval",
              startedAtMs: 1,
              command: "more work",
              cwd: "/tmp",
            },
          },
        ],
      });
      directory = f.directory;
      yield* f.runtime.start();
      yield* f.runtime.sendTurn({ input: "fixture" });
      yield* Deferred.await(f.unconfirmed).pipe(Effect.timeout("10 seconds"));
      // The events stream is a queue with one reader (the fixture), so poll it.
      let request: ProviderEvent | undefined;
      for (let i = 0; i < 200 && !request; i++) {
        request = f.events.find((e) => e.method === "item/commandExecution/requestApproval");
        if (!request) yield* Effect.sleep("25 millis");
      }
      assert.isDefined(request);
      const requestId = request!.requestId!;
      for (const decision of ["accept", "acceptForSession", "acceptAlways"] as const)
        assert.equal(
          (yield* f.runtime.respondToRequest(requestId, decision).pipe(Effect.result))._tag,
          "Failure",
          decision,
        );
      assert.equal(
        (yield* f.runtime.respondToRequest(requestId, "decline").pipe(Effect.result))._tag,
        "Success",
      );
      yield* f.runtime.close;
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      ),
    );
  });

  for (const settles of [true, false]) {
    it.live(
      `a root turn that starts during reconciliation is interrupted: ${settles ? "settled" : "unsettled"}`,
      () => {
        let directory = "";
        return Effect.gen(function* () {
          const f = yield* managedFixture("queued-during-interrupt", {
            turnIds: ["owned-turn"],
            managedTerminals: [{ kind: "owned" }],
            startQueuedOnInterrupt: "queued-turn",
            queuedIgnoresInterrupt: !settles,
          });
          directory = f.directory;
          yield* f.runtime.start();
          yield* f.runtime.sendTurn({ input: "fixture" });
          yield* Deferred.await(f.ready).pipe(Effect.timeout("10 seconds"));
          yield* f.runtime.interruptTurn();
          assert.include(lifecycleOf(f.scriptPath), "interrupt:queued-turn");
          const session = yield* f.runtime.getSession;
          assert.equal(session.status, settles ? "ready" : "error", session.lastError);
          assert.equal(
            (yield* f.runtime.sendTurn({ input: "next" }).pipe(Effect.result))._tag,
            settles ? "Success" : "Failure",
          );
          yield* f.runtime.close;
        }).pipe(
          Effect.scoped,
          Effect.provide(NodeServices.layer),
          Effect.ensuring(
            Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
          ),
        );
      },
    );
  }
});
