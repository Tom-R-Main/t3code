// @effect-diagnostics nodeBuiltinImport:off
import * as NodeNet from "node:net";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it, expect } from "vite-plus/test";
import { listenSiftSocket } from "./Socket.ts";
import { SIFT_BRIDGE_MAX_REQUEST_BYTES } from "../../../../packages/contracts/src/siftBridge.ts";
import * as Schema from "effect/Schema";

const exchange = (socketPath: string, input: string) =>
  new Promise<string>((resolve, reject) => {
    const socket = NodeNet.createConnection(socketPath);
    let response = "";
    socket.on("error", reject);
    socket.on("connect", () => socket.write(input));
    socket.on("data", (data) => {
      response += data.toString();
    });
    socket.on("end", () => resolve(response));
  });

it("retains ordinary raw byte limits while allowing only bootstrap envelope framing room", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sift-socket-bootstrap-"));
  const socketPath = NodePath.join(directory, "bridge.sock");
  let calls = 0;
  const close = await listenSiftSocket(socketPath, async () => { calls++; return { ok: true }; });
  const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
  const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ ok: Schema.optional(Schema.Boolean),
    error: Schema.optional(Schema.Struct({ code: Schema.String })) })));
  try {
    const padding = " ".repeat(SIFT_BRIDGE_MAX_REQUEST_BYTES);
    const ordinary = `${encode({ request: { operation: "workerPolicy/read" } })}${padding}\n`;
    expect(decode(await exchange(socketPath, ordinary)).error?.code).toBe("REQUEST_TOO_LARGE");
    const bootstrap = `${encode({ request: { operation: "workerPolicy/bootstrap" } })}${padding}\n`;
    expect(decode(await exchange(socketPath, bootstrap)).ok).toBe(true);
    expect(calls).toBe(1);
  } finally {
    await close();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("uses an owner-only socket, rejects competing listeners, and bounds malformed input", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sift-socket-"));
  const socketPath = NodePath.join(directory, "bridge.sock");
  let calls = 0;
  const close = await listenSiftSocket(socketPath, async (input) => {
    calls += 1;
    return { ok: true, input };
  });
  try {
    expect((await NodeFSP.stat(socketPath)).mode & 0o777).toBe(0o600);
    await expect(listenSiftSocket(socketPath, async () => ({}))).rejects.toThrow("already active");
    expect(JSON.parse(await exchange(socketPath, '{"id":"one"}\n'))).toEqual({
      ok: true,
      input: { id: "one" },
    });
    expect(JSON.parse(await exchange(socketPath, "{bad}\n")).error.code).toBe("INVALID_REQUEST");
    expect(
      JSON.parse(
        await exchange(socketPath, '"' + "x".repeat(SIFT_BRIDGE_MAX_REQUEST_BYTES) + '"\n'),
      ).error.code,
    ).toBe("REQUEST_TOO_LARGE");
    expect(calls).toBe(1);
  } finally {
    await close();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("refuses shared directories and preserves a preexisting ordinary file", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sift-socket-"));
  const socketPath = NodePath.join(directory, "bridge.sock");
  try {
    await NodeFSP.chmod(directory, 0o755);
    await expect(listenSiftSocket(socketPath, async () => ({}))).rejects.toThrow("owner-only");
    await NodeFSP.chmod(directory, 0o700);
    await NodeFSP.writeFile(socketPath, "preserve");
    await expect(listenSiftSocket(socketPath, async () => ({}))).rejects.toThrow(
      "non-owned socket",
    );
    expect(await NodeFSP.readFile(socketPath, "utf8")).toBe("preserve");
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("interrupts an in-flight handler when its private client disconnects", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sift-socket-cancel-"));
  const socketPath = NodePath.join(directory, "bridge.sock");
  let started!: () => void;
  let cancelled!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const aborted = new Promise<void>((resolve) => { cancelled = resolve; });
  const close = await listenSiftSocket(socketPath, async (_input, signal) => {
    started();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => { cancelled(); resolve(); }, { once: true }));
    return { ok: true };
  });
  const socket = NodeNet.createConnection(socketPath);
  try {
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write('{"id":"preflight"}\n');
    await entered;
    socket.destroy();
    await aborted;
  } finally {
    socket.destroy();
    await close();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
