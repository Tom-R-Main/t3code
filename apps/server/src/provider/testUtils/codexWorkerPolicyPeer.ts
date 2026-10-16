// Model-free protocol fixture: only initialize/start/worker-policy are supported.
import { createInterface } from "node:readline";
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const methods: string[] = [];
createInterface({ input: process.stdin }).on("line", (line: string) => {
  const message = JSON.parse(line) as { id?: string | number; method?: string; params?: {threadId?: string; challenge?: string; prepare?: boolean} };
  if (!message.method) return;
  methods.push(message.method);
  if (message.method === "initialize") send({ id: message.id, result: {
    userAgent: "c4-worker-policy-peer", codexHome: "/fixture", platformFamily: "unix", platformOs: "linux",
  } });
  else if (message.method === "initialized") return;
  else if (message.method === "thread/start") send({ id: message.id, result: {
    cwd: process.cwd(), model: "fixture-model", modelProvider: "fixture-provider", approvalPolicy: "untrusted",
    approvalsReviewer: "user", sandbox: {type: "workspaceWrite", networkAccess: false},
    thread: { id: "provider-thread", cliVersion: "fixture", createdAt: 0, updatedAt: 0,
      cwd: process.cwd(), ephemeral: true, modelProvider: "fixture-provider", preview: "", sessionId: "fixture-session",
      source: "appServer", status: {type: "idle"}, turns: [] },
  } });
  else if (message.method === "workerPolicy/read") {
    if (message.params?.threadId !== "provider-thread") throw new Error("Unbound provider thread");
    send({ id: message.id, result: { attestation: {
      coverageComplete: false, configSha256: null, challenge: message.params.challenge,
      threadId: message.params.challenge === "mismatch" ? "untrusted-asserted-thread" : message.params.threadId, prepare: message.params.prepare, methods,
    } } });
  } else throw new Error(`Unexpected fixture operation: ${message.method}`);
});
