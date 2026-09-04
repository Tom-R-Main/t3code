// @effect-diagnostics nodeBuiltinImport:off
import * as NodeNet from "node:net";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it, expect } from "vite-plus/test";
import { listenSiftSocket } from "./Socket.ts";
import { SIFT_BRIDGE_MAX_REQUEST_BYTES } from "../../../../packages/contracts/src/siftBridge.ts";

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
