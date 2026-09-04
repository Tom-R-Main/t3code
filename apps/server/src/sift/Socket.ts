// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  SIFT_BRIDGE_MAX_REQUEST_BYTES,
  SIFT_BRIDGE_MAX_RESPONSE_BYTES,
} from "../../../../packages/contracts/src/siftBridge.ts";
import { makeSiftBridge } from "./Bridge.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as NodeCrypto from "node:crypto";
import { authenticateSiftRequest, readSiftPublicKey } from "./Authorization.ts";

const failure = (code: string, message: string) => ({
  id: null,
  ok: false,
  error: { code, message },
});

// The socket directory is provisioned by the host, outside the writable checkout.
// Unix owner permissions limit exposure; signed host requests authorize access.
// No HTTP routes or T3 pairing scopes are widened by this opt-in transport.
export async function listenSiftSocket(path: string, handle: (input: unknown) => Promise<unknown>) {
  if (!NodePath.isAbsolute(path) || Buffer.byteLength(path) > 100)
    throw new Error("Invalid Sift socket path.");
  const directory = await NodeFSP.lstat(NodePath.dirname(path));
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (directory.mode & 0o077) !== 0 ||
    directory.uid !== process.getuid?.()
  )
    throw new Error("Sift socket directory must be owner-only.");
  const existing = await NodeFSP.lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) {
    if (!existing.isSocket() || existing.uid !== directory.uid)
      throw new Error("Refusing to replace a non-owned socket.");
    await new Promise<void>((resolve, reject) => {
      const probe = NodeNet.createConnection(path);
      probe.once("connect", () => {
        probe.destroy();
        reject(new Error("Sift socket is already active."));
      });
      probe.once("error", (error: NodeJS.ErrnoException) =>
        error.code === "ECONNREFUSED" ? resolve() : reject(error),
      );
      probe.setTimeout(1000, () => {
        probe.destroy();
        reject(new Error("Sift socket status is uncertain."));
      });
    });
    await NodeFSP.unlink(path);
  }
  const sockets = new Set<NodeNet.Socket>();
  const server = NodeNet.createServer((socket) => {
    if (sockets.size >= 16) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    socket.setTimeout(30_000, () => socket.destroy());
    let input = Buffer.alloc(0);
    let received = false;
    const reply = (value: unknown) => {
      const encoded = JSON.stringify(value);
      socket.end(
        (Buffer.byteLength(encoded) > SIFT_BRIDGE_MAX_RESPONSE_BYTES
          ? JSON.stringify(failure("RESPONSE_TOO_LARGE", "Response exceeded its bound."))
          : encoded) + "\n",
      );
    };
    socket.on("data", (chunk: Buffer) => {
      if (received) return;
      if (input.length + chunk.length > SIFT_BRIDGE_MAX_REQUEST_BYTES) {
        received = true;
        reply(failure("REQUEST_TOO_LARGE", "Request exceeded its bound."));
        return;
      }
      input = Buffer.concat([input, chunk]);
      const newline = input.indexOf(10);
      if (newline < 0) return;
      received = true;
      if (
        input
          .subarray(newline + 1)
          .toString()
          .trim()
      ) {
        reply(failure("INVALID_REQUEST", "Only one request is allowed per connection."));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(input.subarray(0, newline).toString("utf8"));
      } catch {
        reply(failure("INVALID_REQUEST", "Invalid JSON request."));
        return;
      }
      void handle(parsed).then(reply, () =>
        reply(failure("INVALID_REQUEST", "Invalid or unavailable bridge request.")),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    await NodeFSP.chmod(path, 0o600);
  } catch (error) {
    server.close();
    throw error;
  }
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
}

export const listenEffectSiftSocket = (
  path: string,
  handle: (input: unknown, authorize?: () => void) => Effect.Effect<unknown, unknown>,
  publicKey: NodeCrypto.KeyObject,
) =>
  listenSiftSocket(path, async (input) => {
    let request: unknown;
    try {
      request = authenticateSiftRequest(input, publicKey);
    } catch {
      return failure("AUTHORIZATION_FAILED", "Valid host authorization is required.");
    }
    return Effect.runPromise(
      handle(request, () => {
        authenticateSiftRequest(input, publicKey);
      }),
    );
  });

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const path = process.env.T3_SIFT_BRIDGE_SOCKET;
    if (!path) return;
    const encodedPublicKey = process.env.T3_SIFT_BRIDGE_PUBLIC_KEY;
    if (!encodedPublicKey)
      return yield* Effect.fail(new Error("Sift bridge host public key is required."));
    const publicKey = yield* Effect.try(() => readSiftPublicKey(encodedPublicKey));
    const handle = yield* makeSiftBridge;
    const activation = yield* ServerActivation;
    yield* Effect.acquireRelease(
      Effect.tryPromise(() =>
        listenEffectSiftSocket(
          path,
          (input, authorize) =>
            (activation ?? Effect.void).pipe(Effect.andThen(handle(input, authorize))),
          publicKey,
        ),
      ),
      (close) => Effect.promise(close),
    );
  }),
);
