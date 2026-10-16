// @effect-diagnostics nodeBuiltinImport:off
// Model-free protocol fixture: only initialize/start/worker-policy are supported.
import * as NodeReadline from "node:readline";
import * as NodeNet from "node:net";
import * as NodeChildProcess from "node:child_process";
import * as NodeBuffer from "node:buffer";
import * as Schema from "effect/Schema";
import { WorkerBootstrapMaterialization } from "../../../../../packages/contracts/src/workerBootstrap.ts";
const family = NodeChildProcess.spawnSync("python3", ["-c",
  "import socket; s=socket.socket(fileno=3); assert s.family==socket.AF_UNIX and s.type==socket.SOCK_STREAM; assert s.getpeername() is not None; print('unix-stream')"],
  { stdio: ["ignore", "pipe", "pipe", 3], encoding: "utf8", timeout: 1000 });
if (family.status !== 0 || family.stdout.trim() !== "unix-stream") throw new Error("Fixture FD3 is not a connected Unix stream");
const bootstrap = await new Promise<string>((resolve, reject) => {
  const socket = new NodeNet.Socket({ fd: 3, readable: true, writable: false });
  const chunks: Uint8Array[] = [];
  let size = 0;
  socket.setTimeout(5000, () => socket.destroy(new Error("Fixture bootstrap deadline")));
  socket.on("data", (chunk: Uint8Array) => {
    size += chunk.byteLength;
    if (size > 262_144) socket.destroy(new Error("Fixture bootstrap bound"));
    else chunks.push(chunk);
  });
  socket.on("error", () => reject(new Error("Fixture bootstrap unavailable")));
  socket.on("end", () => { socket.destroy(); resolve(NodeBuffer.Buffer.concat(chunks).toString("utf8")); });
});
Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
  version: Schema.Literal(1), materialization: WorkerBootstrapMaterialization,
})))(bootstrap, { onExcessProperty: "error" });
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const send = (value: unknown) => process.stdout.write(`${encode(value)}\n`);
const methods: string[] = ["fd3-unix-stream-eof"];
const decodeMessage = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
})));
const decodeInspection = Schema.decodeUnknownSync(Schema.Struct({ threadId: Schema.Literal("provider-thread"),
  challenge: Schema.String, prepare: Schema.Boolean }));
const decodeTurn = Schema.decodeUnknownSync(Schema.Struct({ threadId: Schema.Literal("provider-thread"),
  input: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })) }));
let threadStart: unknown;
let turnStart: unknown;
NodeReadline.createInterface({ input: process.stdin }).on("line", (line: string) => {
  const message = decodeMessage(line);
  if (!message.method) return;
  methods.push(message.method);
  if (message.method === "initialize") send({ id: message.id, result: {
    userAgent: "c4-worker-policy-peer", codexHome: "/fixture", platformFamily: "unix", platformOs: "linux",
  } });
  else if (message.method === "initialized") return;
  else if (message.method === "thread/start") {
    // Mirror the native sealed profile's minimal accepted request, including
    // rejecting fields a permissive protocol mock would silently strip.
    threadStart = Schema.decodeUnknownSync(Schema.Struct({}))(message.params, { onExcessProperty: "error" });
    send({ id: message.id, result: {
    cwd: process.cwd(), model: "fixture-model", modelProvider: "fixture-provider", approvalPolicy: "never",
    approvalsReviewer: "user", sandbox: {type: "readOnly", networkAccess: false},
    thread: { id: "provider-thread", cliVersion: "fixture", createdAt: 0, updatedAt: 0,
      cwd: process.cwd(), ephemeral: true, modelProvider: "fixture-provider", preview: "", sessionId: "fixture-session",
      source: "appServer", status: {type: "idle"}, turns: [] },
  } });
  } else if (message.method === "turn/start") {
    turnStart = decodeTurn(message.params, { onExcessProperty: "error" });
    send({ id: message.id, result: { turn: { id: "sealed-turn", items: [], status: "inProgress" } } });
  }
  else if (message.method === "workerPolicy/read") {
    const params = decodeInspection(message.params, { onExcessProperty: "error" });
    send({ id: message.id, result: { attestation: {
      coverageComplete: false, configSha256: null, challenge: params.challenge,
      threadId: params.challenge === "mismatch" ? "untrusted-asserted-thread" : params.threadId, prepare: params.prepare, methods,
      ...(turnStart ? { threadStart, turnStart } : {}),
    } } });
  } else throw new Error(`Unexpected fixture operation: ${message.method}`);
});
