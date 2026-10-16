import { describe, expect, it } from "vite-plus/test";
import { isWorkerPolicyChallenge, readWorkerPolicyLaunch } from "./WorkerPolicy.ts";
const launch = {
  version: 1, launchId: "launch", incarnationId: "incarnation", bindingSha256: "a".repeat(64),
  executorProtocolVersion: "sift-worker-executor-v1", server: "executor", namespace: "sift",
  tool: "execute", rawTool: "execute", endpoint: "http://127.0.0.1:4321/mcp",
  serverConfigSha256: "b".repeat(64), model: "model", modelProviderId: "provider",
  modelProviderSha256: "c".repeat(64),
};
describe("private worker policy inspection", () => {
  it("bounds the exact challenge in UTF-8 without lossy Unicode or controls", () => {
    expect(isWorkerPolicyChallenge("😀".repeat(64))).toBe(true);
    for (const value of ["", "😀".repeat(65), "line\nbreak", "nul\0", "\ud800", "\udfff", "\u007f"])
      expect(isWorkerPolicyChallenge(value)).toBe(false);
  });
  it("accepts only the complete launcher environment, never a partial policy", () => {
    const env = { CODEX_RESTRICTED_WORKER: "1", CODEX_WORKER_POLICY_V1: JSON.stringify(launch) };
    expect(readWorkerPolicyLaunch(env)).toEqual(launch);
    for (const changed of [
      { ...env, CODEX_RESTRICTED_WORKER: "0" },
      { ...env, CODEX_WORKER_POLICY_V1: "{}" },
      { ...env, CODEX_WORKER_POLICY_V1: JSON.stringify({ ...launch, executorProtocolVersion: "full-access" }) },
      { ...env, CODEX_WORKER_POLICY_V1: JSON.stringify({ ...launch, extra: "untrusted" }) },
      { ...env, CODEX_WORKER_POLICY_V1: JSON.stringify({ ...launch, incarnationId: undefined }) },
    ]) expect(readWorkerPolicyLaunch(changed)).toBeUndefined();
  });
});
