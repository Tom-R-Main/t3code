// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";

const Envelope = Schema.Struct({
  request: Schema.Unknown,
  authorization: Schema.Struct({
    expiresAt: Schema.Int,
    signature: Schema.String.check(Schema.isMinLength(86), Schema.isMaxLength(86)),
  }),
});
const decodeEnvelope = Schema.decodeUnknownSync(Envelope);

export const canonicalSiftAuthorization = (request: unknown, expiresAt: number): string =>
  JSON.stringify({ request, expiresAt }, (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : value,
  );

export const readSiftPublicKey = (encoded: string): NodeCrypto.KeyObject => {
  const key = NodeCrypto.createPublicKey({
    key: Buffer.from(encoded, "base64"),
    type: "spki",
    format: "der",
  });
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("Sift bridge requires an Ed25519 public key.");
  return key;
};

// Shell tools run under the worker UID too. Socket permissions alone cannot
// authorize human responses: only the host retains the signing private key.
export const authenticateSiftRequest = (
  input: unknown,
  key: NodeCrypto.KeyObject,
  // @effect-diagnostics-next-line globalDate:off - synchronous check run from socket callbacks and before each dispatch.
  now = Date.now(),
): unknown => {
  const envelope = decodeEnvelope(input, { onExcessProperty: "error" });
  const { expiresAt, signature } = envelope.authorization;
  if (expiresAt <= now || expiresAt > now + 60_000 || !/^[A-Za-z0-9_-]{86}$/.test(signature))
    throw new Error("Invalid bridge authorization.");
  if (
    !NodeCrypto.verify(
      null,
      Buffer.from(canonicalSiftAuthorization(envelope.request, expiresAt)),
      key,
      Buffer.from(signature, "base64url"),
    )
  )
    throw new Error("Invalid bridge authorization.");
  return envelope.request;
};
