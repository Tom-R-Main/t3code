import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { SiftBridgeRequest } from "./siftBridge.ts";

const decode = Schema.decodeUnknownSync(SiftBridgeRequest);
const base = {
  id: "wire-1", binding: { runtimeId: "runtime", workItemId: "work", leaseGeneration: 1 },
  operation: "approve", commandId: "command", requestId: "request", attemptId: "attempt",
};
describe("Sift guarded decision wire", () => {
  it("carries exact scope while keeping the native decision one-time", () => {
    const expectedApprovalScope = { version: 1, kind: "network", digest: "a".repeat(64) };
    expect(decode({ ...base, decision: "accept", expectedApprovalScope, ruleSourceRequestId: "source" })).toMatchObject({ expectedApprovalScope });
    for (const decision of ["acceptAlways", "acceptForSession"]) {
      expect(() => decode({ ...base, decision, expectedApprovalScope })).toThrow();
    }
    expect(() => decode({ ...base, decision: "accept", expectedApprovalScope: { ...expectedApprovalScope, digest: "bad" } })).toThrow();
  });
  it("bounds feedback by Unicode code points", () => {
    const feedback = "😀".repeat(4000);
    expect(decode({ ...base, decision: "decline", feedback })).toMatchObject({ feedback });
    expect(() => decode({ ...base, decision: "decline", feedback: `${feedback}x` })).toThrow();
    expect(() => decode({ ...base, decision: "decline", feedback: "  " })).toThrow();
  });
});

it("carries bounded worker-policy requests without granting a turn operation", () => {
  const input = { id: "preflight", binding: base.binding, operation: "workerPolicy/read",
    threadId: "bound-thread", challenge: "challenge", prepare: true };
  expect(decode(input)).toEqual(input);
  expect(() => decode({ ...input, challenge: "" })).toThrow();
  expect(() => decode({ ...input, challenge: "x".repeat(257) })).toThrow();
  expect(() => decode({ ...input, prepare: "true" })).toThrow();
});
