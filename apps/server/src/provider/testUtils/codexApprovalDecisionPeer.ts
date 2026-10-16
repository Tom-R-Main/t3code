// A protocol peer for approval tests. It has no provider binary, auth, or model.
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

const scenario = process.argv[2];
const effectFile = process.argv[3];
const fixtureScript = "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({effect:'approved fixture effect',argv0:process.argv0}), {flag:'wx'});";
const commandScope = effectFile ? {
  version: 1, program: process.argv[4] ?? process.execPath, argv: ["fixture-node-zero", "-e", fixtureScript, effectFile], cwd: dirname(effectFile),
} : undefined;
const events: string[] = [];
let steeredFeedback: string | undefined;
let beginId: string | number | undefined;
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
createInterface({ input: process.stdin }).on("line", (line: string) => {
  const message = JSON.parse(line) as {
    id?: string | number; method?: string;
    params?: { expectedTurnId?: string; input?: ReadonlyArray<{ type: string; text?: string }> }; result?: { decision?: string };
  };
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "c3a-scripted-peer", codexHome: "/fixture", platformFamily: "unix", platformOs: "linux" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: {
      cwd: process.cwd(), model: "gpt-5.4", modelProvider: "openai", approvalPolicy: "on-request",
      approvalsReviewer: "user", sandbox: { type: "workspaceWrite", networkAccess: false },
      thread: { id: "provider-thread", cliVersion: "fixture", createdAt: 0, updatedAt: 0,
        cwd: process.cwd(), ephemeral: true, modelProvider: "openai", preview: "", sessionId: "fixture-session",
        source: "appServer", status: { type: "idle" }, turns: [] },
    } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-1", items: [], status: "inProgress" } } });
    send({ jsonrpc: "2.0", id: "approval-1", method: "item/commandExecution/requestApproval", params: {
      threadId: "provider-thread", turnId: "turn-1", itemId: "item-1", startedAtMs: 1,
      ...(commandScope
        ? { ...(scenario === "command-legacy" ? {} : { siftCommandScope: commandScope }),
          command: "display text is not execution authority", cwd: commandScope.cwd }
        : { networkApprovalContext: { host: "example.com", protocol: "https" } }),
    } });
  } else if (message.method === "fixture/begin") {
    beginId = message.id;
    send({ jsonrpc: "2.0", id: "approval-1", method: "item/commandExecution/requestApproval", params: {
      threadId: "provider-thread", turnId: "turn-1", itemId: "item-1", startedAtMs: 1,
      ...(commandScope
        ? { ...(scenario === "command-legacy" ? {} : { siftCommandScope: commandScope }),
          command: "display text is not execution authority", cwd: commandScope.cwd }
        : { networkApprovalContext: { host: "example.com", protocol: "https" } }),
    } });
  } else if (message.method === "turn/steer") {
    events.push("steer");
    if (message.params?.expectedTurnId !== "turn-1") throw new Error("Feedback did not target the existing turn");
    steeredFeedback = message.params.input?.find((item) => item.type === "text")?.text;
    if (scenario === "lost-reply") { process.exitCode = 0; process.stdin.destroy(); return; }
    if (scenario === "stale-turn") {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Active turn changed" } });
    } else {
      send({ jsonrpc: "2.0", id: message.id, result: { turnId: message.params?.expectedTurnId } });
    }
  } else if (message.id === "approval-1" && message.result) {
    events.push(message.result.decision ?? "missing-decision");
    if (commandScope && message.result.decision === "accept") {
      // Execute exactly the vector whose typed scope was sent above. This child
      // is a model-free fixture with one exclusive-create effect in a test tempdir.
      const result = spawnSync(commandScope.program, commandScope.argv.slice(1), {
        cwd: commandScope.cwd, argv0: commandScope.argv[0], stdio: "pipe", timeout: 5000,
      });
      if (result.status !== 0) throw new Error("Fixture command did not complete");
      send({ method: "item/agentMessage/delta", params: { threadId: "provider-thread", turnId: "turn-1",
        itemId: "fixture-effect", delta: "Fixture tool effect completed." } });
    }
    if (message.result.decision === "decline") send({ method: "item/agentMessage/delta", params: {
      threadId: "provider-thread", turnId: "turn-1", itemId: "continuation",
      delta: `Synthetic peer consumed native decline after steering. turn=turn-1 feedback=${JSON.stringify(steeredFeedback)}`,
    } });
    if (beginId !== undefined) send({ jsonrpc: "2.0", id: beginId, result: { events } });
  }
});
