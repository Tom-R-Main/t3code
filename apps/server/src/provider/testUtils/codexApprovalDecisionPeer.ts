// A protocol peer for approval tests. It has no provider binary, auth, or model.
import * as NodeReadline from "node:readline";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as CodexSchema from "effect-codex-app-server/schema";

const path = await Effect.runPromise(Path.Path.pipe(Effect.provide(NodePath.layer)));
const scenario = process.argv[2];
const effectFile = process.argv[3];
const childApproval = scenario === "child-success" || scenario === "child-stale";
const approvalThreadId = childApproval ? "child-thread" : "provider-thread";
const approvalTurnId = childApproval ? "child-turn-1" : "turn-1";
const fixtureScript =
  "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({effect:'approved fixture effect',argv0:process.argv0}), {flag:'wx'});";
const commandScope = effectFile
  ? {
      version: 1,
      program: process.argv[4] ?? process.execPath,
      argv: ["fixture-node-zero", "-e", fixtureScript, effectFile] as const,
      cwd: path.dirname(effectFile),
    }
  : undefined;
// The pinned Effect spawner has no argv0 option. This fixed Bash adapter
// passes each operand as a positional argument to execve without parsing it.
// The child observes and writes the independently chosen native argv[0].
const executeFixture = (scope: NonNullable<typeof commandScope>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        "/bin/bash",
        [
          "-c",
          'exec -a "$1" "$2" "${@:3}"',
          "c3a-native-exec",
          scope.argv[0],
          scope.program,
          ...scope.argv.slice(1),
        ],
        {
          cwd: scope.cwd,
          shell: false,
          detached: false,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      ),
    );
    if (Number(yield* child.exitCode) !== 0)
      return yield* Effect.die(new Error("Fixture command did not complete"));
  }).pipe(Effect.timeout("5 seconds"), Effect.scoped, Effect.provide(NodeServices.layer));

const events: string[] = [];
let steeredFeedback: string | undefined;
let beginId: string | number | undefined;
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const completeAssistant = (itemId: string, text: string) => {
  send({
    method: "item/agentMessage/delta",
    params: {
      threadId: "provider-thread",
      turnId: "turn-1",
      itemId,
      delta: text,
    },
  });
  // The production ingestion path buffers paragraph text until a real item
  // lifecycle boundary. A delta alone is not a completed peer continuation.
  const params: CodexSchema.V2ItemCompletedNotification = {
    completedAtMs: 2,
    threadId: "provider-thread",
    turnId: "turn-1",
    item: { type: "agentMessage", id: itemId, text },
  };
  send({ method: "item/completed", params });
};
NodeReadline.createInterface({ input: process.stdin }).on("line", (line: string) => {
  const message = JSON.parse(line) as {
    id?: string | number;
    method?: string;
    params?: {
      threadId?: string;
      expectedTurnId?: string;
      input?: ReadonlyArray<{ type: string; text?: string }>;
    };
    result?: { decision?: string };
  };
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        userAgent: "c3a-scripted-peer",
        codexHome: "/fixture",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
  } else if (message.method === "thread/start") {
    send({
      id: message.id,
      result: {
        cwd: process.cwd(),
        model: "gpt-5.4",
        modelProvider: "openai",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: { type: "workspaceWrite", networkAccess: false },
        thread: {
          id: "provider-thread",
          cliVersion: "fixture",
          createdAt: 0,
          updatedAt: 0,
          cwd: process.cwd(),
          ephemeral: true,
          modelProvider: "openai",
          preview: "",
          sessionId: "fixture-session",
          source: "appServer",
          status: { type: "idle" },
          turns: [],
        },
      },
    });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-1", items: [], status: "inProgress" } } });
    if (childApproval) {
      const params: CodexSchema.V2TurnStartedNotification = {
        threadId: approvalThreadId,
        turn: {
          id: scenario === "child-stale" ? "child-turn-2" : approvalTurnId,
          items: [],
          status: "inProgress",
        },
      };
      send({ method: "turn/started", params });
      completeAssistant("child-live-confirmation", "Child turn observation barrier.");
    }
    send({
      jsonrpc: "2.0",
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: approvalThreadId,
        turnId: approvalTurnId,
        itemId: "item-1",
        startedAtMs: 1,
        ...(commandScope
          ? {
              ...(scenario === "command-legacy" ? {} : { siftCommandScope: commandScope }),
              command: "display text is not execution authority",
              cwd: commandScope.cwd,
            }
          : { networkApprovalContext: { host: "example.com", protocol: "https" } }),
      },
    });
  } else if (message.method === "fixture/begin") {
    beginId = message.id;
    send({
      jsonrpc: "2.0",
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: approvalThreadId,
        turnId: approvalTurnId,
        itemId: "item-1",
        startedAtMs: 1,
        ...(commandScope
          ? {
              ...(scenario === "command-legacy" ? {} : { siftCommandScope: commandScope }),
              command: "display text is not execution authority",
              cwd: commandScope.cwd,
            }
          : { networkApprovalContext: { host: "example.com", protocol: "https" } }),
      },
    });
  } else if (message.method === "turn/steer") {
    events.push("steer");
    if (
      message.params?.threadId !== approvalThreadId ||
      message.params.expectedTurnId !== approvalTurnId
    )
      throw new Error("Feedback did not target the requesting native thread and turn");
    steeredFeedback = message.params.input?.find((item) => item.type === "text")?.text;
    if (scenario === "lost-reply") {
      process.exitCode = 0;
      process.stdin.destroy();
      return;
    }
    if (scenario === "stale-turn") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32602, message: "Active turn changed" },
      });
    } else {
      send({ jsonrpc: "2.0", id: message.id, result: { turnId: message.params?.expectedTurnId } });
    }
  } else if (message.id === "approval-1" && message.result) {
    events.push(message.result.decision ?? "missing-decision");
    if (commandScope && message.result.decision === "accept") {
      // Execute exactly the vector whose typed scope was sent above. This child
      // is a model-free fixture with one exclusive-create effect in a test tempdir.
      void Effect.runPromise(executeFixture(commandScope))
        .then(() => {
          completeAssistant("fixture-effect", "Fixture tool effect completed.");
          if (beginId !== undefined) send({ jsonrpc: "2.0", id: beginId, result: { events } });
        })
        .catch(() => {
          process.stderr.write("Fixture command did not complete\n");
          process.exitCode = 1;
          process.stdin.destroy();
        });
      return;
    }
    if (message.result.decision === "decline")
      completeAssistant(
        "continuation",
        `Synthetic peer consumed native decline after steering. ${childApproval ? `thread=${approvalThreadId} ` : ""}turn=${approvalTurnId} feedback=${JSON.stringify(steeredFeedback)}`,
      );
    if (beginId !== undefined) send({ jsonrpc: "2.0", id: beginId, result: { events } });
  }
});
