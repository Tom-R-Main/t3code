// @effect-diagnostics nodeBuiltinImport:off
import * as NodeBuffer from "node:buffer";
import * as Schema from "effect/Schema";

const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const WorkerPolicyLaunch = Schema.Struct({
  version: Schema.Literal(1),
  launchId: Identifier,
  incarnationId: Identifier,
  bindingSha256: Digest,
  executorProtocolVersion: Schema.Literal("sift-worker-executor-v1"),
  server: Identifier,
  namespace: Identifier,
  tool: Identifier,
  rawTool: Identifier,
  endpoint: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  serverConfigSha256: Digest,
  model: Identifier,
  modelProviderId: Identifier,
  modelProviderSha256: Digest,
  configSchemaVersion: Schema.Literal("sift-worker-effective-config-v1"),
  configSha256: Digest,
});
export function isWorkerPolicyChallenge(value: string): boolean {
  return NodeBuffer.Buffer.byteLength(value) >= 1 && NodeBuffer.Buffer.byteLength(value) <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    !Array.from(value).some((character) => {
      const point = character.codePointAt(0)!;
      return point >= 0xd800 && point <= 0xdfff;
    });
}

// Only launcher-owned environment carries worker authority. Never recover it
// from a prompt, bridge bind, or mutable provider-instance configuration.
export function readWorkerPolicyLaunch(environment: NodeJS.ProcessEnv): typeof WorkerPolicyLaunch.Type | undefined {
  if (environment.CODEX_RESTRICTED_WORKER !== "1" || !environment.CODEX_WORKER_POLICY_V1 ||
    NodeBuffer.Buffer.byteLength(environment.CODEX_WORKER_POLICY_V1) > 16384) return undefined;
  try {
    const launch = Schema.decodeUnknownSync(Schema.fromJsonString(WorkerPolicyLaunch))(
      environment.CODEX_WORKER_POLICY_V1, { onExcessProperty: "error" },
    );
    if (Object.values(launch).some((value) => typeof value === "string" && (
      /[\u0000-\u001f\u007f]/.test(value) || Array.from(value).some((character) => {
        const point = character.codePointAt(0)!;
        return point >= 0xd800 && point <= 0xdfff;
      })
    ))) return undefined;
    return launch;
  } catch { return undefined; }
}
