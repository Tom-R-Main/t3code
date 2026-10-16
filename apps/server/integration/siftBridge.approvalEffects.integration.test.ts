// @effect-diagnostics nodeBuiltinImport:off
import * as Assert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ApprovalScope, type ApprovalRequestId, type ProviderApprovalDecision, type ApprovalDecisionContext } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { makeCodexSessionRuntime } from "../src/provider/Layers/CodexSessionRuntime.ts";
import { makeOrchestrationIntegrationHarness } from "./OrchestrationEngineHarness.integration.ts";

const ApprovalInfo = Schema.Struct({
  requestId: Schema.String, detail: Schema.String, approvalScope: ApprovalScope,
  feedbackSupported: Schema.Literal(true),
});

for (const scenario of ["success", "stale-turn", "lost-reply", "scope-mismatch"] as const) {
  it.live(`correlates guarded ${scenario} through Bridge, reactor, actual Codex runtime, and scripted peer`, () =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const actualSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const peer = path.join(import.meta.dirname, "../src/provider/testUtils/codexApprovalDecisionPeer.ts");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let responseCalls = 0;
      const scriptedSpawner = ChildProcessSpawner.make(() => actualSpawner.spawn(
        ChildProcess.make(process.execPath, [peer, scenario]),
      ));
      const harness = yield* makeOrchestrationIntegrationHarness({
        realCodex: true,
        codexRuntimeFactory: (options) => makeCodexSessionRuntime({ ...options, binaryPath: process.execPath }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, scriptedSpawner),
          Effect.map((runtime) => ({ ...runtime,
            respondToRequest: (requestId: ApprovalRequestId, decision: ProviderApprovalDecision, context?: ApprovalDecisionContext) => Effect.gen(function* () {
              responseCalls++;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              yield* runtime.respondToRequest(requestId, decision, context);
            }),
          })),
        ),
      });
      yield* Effect.addFinalizer(() => harness.dispose);
      const base = { id: "guarded", binding: { runtimeId: "runtime", workItemId: "work", leaseGeneration: 1 } };
      const bound = yield* harness.siftBridge({ ...base, operation: "bind", checkoutPath: harness.workspaceDir,
        runtimeMode: "approval-required", modelSelection: { instanceId: "codex", model: "gpt-5.4" } });
      Assert.equal(bound.ok, true);
      yield* harness.siftBridge({ ...base, operation: "turn", commandId: "turn", text: "Use only the synthetic peer." });
      const events = yield* harness.waitForDomainEvent((event) => event.type === "thread.activity-appended" &&
        event.payload.activity.kind === "approval.requested");
      const approvalEvent = events.find((event) => event.type === "thread.activity-appended" &&
        event.payload.activity.kind === "approval.requested");
      if (!approvalEvent || approvalEvent.type !== "thread.activity-appended") throw new Error("No approval event");
      const approval = Schema.decodeUnknownSync(ApprovalInfo)(approvalEvent.payload.activity.payload);
      // This peer supplies neither command nor reason. The host remains visible to the human.
      Assert.equal(approval.detail, "Network target: https example.com");
      const request = { ...base, operation: "approve", commandId: "decision", requestId: approval.requestId,
        attemptId: "attempt-1", decision: scenario === "scope-mismatch" ? "accept" : "decline",
        ...(scenario === "scope-mismatch"
          ? { expectedApprovalScope: { ...approval.approvalScope, digest: "0".repeat(64) } }
          : { feedback: "Use the retained local fixture." }),
      };
      const first = yield* harness.siftBridge(request);
      Assert.equal(first.ok && first.result.state, "pending");
      yield* Deferred.await(entered);
      const pendingRetry = yield* harness.siftBridge(request);
      Assert.equal(pendingRetry.ok && pendingRetry.result.state, "pending");
      Assert.equal(responseCalls, 1);
      yield* Deferred.succeed(release, undefined);
      yield* harness.drainProviderCommands;
      const settled = yield* harness.siftBridge(request);
      if (scenario === "success") {
        Assert.equal(settled.ok && settled.result.state, "accepted");
        yield* harness.waitForDomainEvent((event) => event.type === "thread.message-sent" &&
          event.payload.role === "assistant" && event.payload.text.includes('consumed native decline after steering. turn=turn-1 feedback="Use the retained local fixture."'));
        const resolved = yield* harness.waitForDomainEvent((event) => event.type === "thread.activity-appended" &&
          event.payload.activity.kind === "approval.resolved");
        Assert.ok(resolved.some((event) => event.type === "thread.activity-appended" &&
          event.payload.activity.kind === "approval.resolved" &&
          Schema.is(Schema.Struct({ feedbackDelivered: Schema.Literal(true) }))(event.payload.activity.payload)));
      } else {
        const error = scenario === "scope-mismatch" ? "APPROVAL_SCOPE_MISMATCH" : "FEEDBACK_DELIVERY_UNKNOWN";
        Assert.deepEqual(settled.ok && settled.result, { threadId: bound.ok && bound.result.threadId, state: "failed", error });
        const failed = yield* harness.waitForDomainEvent((event) => event.type === "thread.activity-appended" &&
          event.payload.activity.kind === "provider.approval.respond.failed");
        Assert.ok(failed.some((event) => event.type === "thread.activity-appended" &&
          Schema.is(Schema.Struct({ errorCode: Schema.Literal(error) }))(event.payload.activity.payload)));
      }
      Assert.deepEqual(yield* harness.siftBridge(request), settled);
      Assert.equal(responseCalls, 1, "Stable retries must not invoke runtime again");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}


for (const scenario of ["command-accept", "command-scope-mismatch", "command-legacy"] as const) {
  it.live(`requires exact command authority before the fixture tool effect: ${scenario}`, () =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const actualSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "c3a-command-effect-" });
      const effectFile = path.join(tempDir, "approved-effect.txt");
      const fixtureProgram = path.join(tempDir, "node-fixture");
      yield* fs.symlink(process.execPath, fixtureProgram);
      const peer = path.join(import.meta.dirname, "../src/provider/testUtils/codexApprovalDecisionPeer.ts");
      const scriptedSpawner = ChildProcessSpawner.make(() => actualSpawner.spawn(
        ChildProcess.make(process.execPath, [peer, scenario, effectFile, fixtureProgram]),
      ));
      let responseCalls = 0;
      const harness = yield* makeOrchestrationIntegrationHarness({
        realCodex: true,
        codexRuntimeFactory: (options) => makeCodexSessionRuntime({ ...options, binaryPath: process.execPath }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, scriptedSpawner),
          Effect.map((runtime) => ({ ...runtime,
            respondToRequest: (requestId: ApprovalRequestId, decision: ProviderApprovalDecision, context?: ApprovalDecisionContext) => {
              responseCalls++;
              return runtime.respondToRequest(requestId, decision, context);
            },
          })),
        ),
      });
      yield* Effect.addFinalizer(() => harness.dispose);
      const base = { id: "command-effect", binding: { runtimeId: "runtime-command", workItemId: "work-command", leaseGeneration: 1 } };
      const bound = yield* harness.siftBridge({ ...base, operation: "bind", checkoutPath: harness.workspaceDir,
        runtimeMode: "approval-required", modelSelection: { instanceId: "codex", model: "gpt-5.4" } });
      Assert.equal(bound.ok, true);
      yield* harness.siftBridge({ ...base, operation: "turn", commandId: "turn", text: "Use only the synthetic command peer." });
      const events = yield* harness.waitForDomainEvent((event) => event.type === "thread.activity-appended" &&
        event.payload.activity.kind === "approval.requested");
      const event = events.find((item) => item.type === "thread.activity-appended" &&
        item.payload.activity.kind === "approval.requested");
      if (!event || event.type !== "thread.activity-appended") throw new Error("No command approval event");
      const approval = Schema.decodeUnknownSync(Schema.Struct({
        requestId: Schema.String, approvalScope: Schema.optional(ApprovalScope),
      }))(event.payload.activity.payload);
      Assert.equal(JSON.stringify(event).includes("siftCommandScope"), false, "Raw argv extension must not reach persisted activity");
      Assert.equal(yield* fs.exists(effectFile), false, "The peer must wait for approval before executing the fixture");
      if (scenario !== "command-legacy") Assert.equal(approval.approvalScope?.kind, "command");
      else Assert.equal(approval.approvalScope, undefined);
      const expectedScope = scenario === "command-accept" ? approval.approvalScope : {
        version: 1 as const, kind: "command" as const, digest: "0".repeat(64),
      };
      const request = { ...base, operation: "approve", commandId: "effect-decision", requestId: approval.requestId,
        attemptId: "effect-attempt", decision: "accept", expectedApprovalScope: expectedScope,
        ruleSourceRequestId: "prior-exact-command-request",
      };
      yield* harness.siftBridge(request);
      yield* harness.drainProviderCommands;
      const settled = yield* harness.siftBridge(request);
      if (scenario === "command-accept") {
        Assert.equal(settled.ok && settled.result.state, "accepted");
        // An accepted response alone is insufficient: wait for the independently
        // executed child command, then inspect its exclusive-create file effect.
        yield* harness.waitForDomainEvent((item) => item.type === "thread.message-sent" &&
          item.payload.role === "assistant" && item.payload.text.includes("Fixture tool effect completed."));
        Assert.deepEqual(JSON.parse(yield* fs.readFileString(effectFile)), {
          effect: "approved fixture effect", argv0: "fixture-node-zero",
        });
      } else {
        Assert.deepEqual(settled.ok && settled.result, {
          threadId: bound.ok && bound.result.threadId, state: "failed", error: "APPROVAL_SCOPE_MISMATCH",
        });
        Assert.equal(yield* fs.exists(effectFile), false);
      }
      Assert.deepEqual(yield* harness.siftBridge(request), settled);
      Assert.equal(responseCalls, 1, "Replaying a decision receipt must not release another command");
      if (scenario === "command-accept") {
        const stale = yield* harness.siftBridge({ ...request, commandId: "different-decision" });
        Assert.equal(stale.ok && stale.result.state, "failed");
        Assert.equal(responseCalls, 1, "An old decision ID must never reach the provider twice");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
