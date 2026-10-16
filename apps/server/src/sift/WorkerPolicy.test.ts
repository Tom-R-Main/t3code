import { describe, expect, it } from "vite-plus/test";
import { isWorkerPolicyChallenge, readWorkerPolicyLaunch } from "./WorkerPolicy.ts";
import * as Schema from "effect/Schema";
const launch = {
  version: 1, launchId: "launch", incarnationId: "incarnation", bindingSha256: "a".repeat(64),
  executorProtocolVersion: "sift-worker-executor-v1", server: "executor", namespace: "sift",
  tool: "execute", rawTool: "execute", endpoint: "http://127.0.0.1:4321/mcp",
  serverConfigSha256: "b".repeat(64), model: "model", modelProviderId: "provider",
  modelProviderSha256: "c".repeat(64),
  configSchemaVersion: "sift-worker-effective-config-v1", configSha256: "d".repeat(64),
};
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
describe("private worker policy inspection", () => {
  it("bounds the exact challenge in UTF-8 without lossy Unicode or controls", () => {
    expect(isWorkerPolicyChallenge("😀".repeat(64))).toBe(true);
    for (const value of ["", "😀".repeat(65), "line\nbreak", "nul\0", "\ud800", "\udfff", "\u007f"])
      expect(isWorkerPolicyChallenge(value)).toBe(false);
  });
  it("accepts only the complete launcher environment, never a partial policy", () => {
    const env = { CODEX_RESTRICTED_WORKER: "1", CODEX_WORKER_POLICY_V1: encode(launch) };
    expect(readWorkerPolicyLaunch(env)).toEqual(launch);
    for (const changed of [
      { ...env, CODEX_RESTRICTED_WORKER: "0" },
      { ...env, CODEX_WORKER_POLICY_V1: "{}" },
      { ...env, CODEX_WORKER_POLICY_V1: encode({ ...launch, executorProtocolVersion: "full-access" }) },
      { ...env, CODEX_WORKER_POLICY_V1: encode({ ...launch, extra: "untrusted" }) },
      { ...env, CODEX_WORKER_POLICY_V1: encode({ ...launch, incarnationId: undefined }) },
      { ...env, CODEX_WORKER_POLICY_V1: encode({ ...launch, configSha256: undefined }) },
    ]) expect(readWorkerPolicyLaunch(changed)).toBeUndefined();
  });
});
