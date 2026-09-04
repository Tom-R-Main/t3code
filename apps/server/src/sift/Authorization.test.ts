// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import { it, expect } from "vite-plus/test";
import {
  authenticateSiftRequest,
  canonicalSiftAuthorization,
  readSiftPublicKey,
} from "./Authorization.ts";

it("accepts only unexpired, host-signed payloads with a pinned Ed25519 key", () => {
  const { publicKey, privateKey } = NodeCrypto.generateKeyPairSync("ed25519");
  const pinned = readSiftPublicKey(
    publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  );
  const request = {
    id: "approval",
    operation: "approve",
    decision: "accept",
    binding: { workItemId: "work", runtimeId: "runtime", leaseGeneration: 1 },
  };
  const now = 1_000_000;
  const expiresAt = now + 30_000;
  const signature = NodeCrypto.sign(
    null,
    Buffer.from(canonicalSiftAuthorization(request, expiresAt)),
    privateKey,
  ).toString("base64url");
  const envelope = { request, authorization: { expiresAt, signature } };
  expect(authenticateSiftRequest(envelope, pinned, now)).toEqual(request);
  expect(() => authenticateSiftRequest(request, pinned, now)).toThrow();
  expect(() => authenticateSiftRequest(envelope, pinned, expiresAt)).toThrow();
  expect(() => authenticateSiftRequest(envelope, pinned, now - 60_000)).toThrow();
  expect(() =>
    authenticateSiftRequest(
      { ...envelope, request: { ...request, decision: "decline" } },
      pinned,
      now,
    ),
  ).toThrow();
  expect(() =>
    authenticateSiftRequest(envelope, NodeCrypto.generateKeyPairSync("ed25519").publicKey, now),
  ).toThrow();
  expect(canonicalSiftAuthorization({ z: [{ b: 2, a: 1 }], a: true }, 1)).toBe(
    '{"expiresAt":1,"request":{"a":true,"z":[{"a":1,"b":2}]}}',
  );
});
