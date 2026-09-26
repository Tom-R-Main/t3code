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
