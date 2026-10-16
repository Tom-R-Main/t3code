// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  ApprovalScope,
  ApprovalRequestId,
  CommandId,
  ThreadId,
  type ProviderApprovalDecision,
  type ApprovalDecisionContext,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { makeCodexSessionRuntime } from "../src/provider/Layers/CodexSessionRuntime.ts";
import {
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "./OrchestrationEngineHarness.integration.ts";

const waitForCompletedAssistantText = (
  harness: OrchestrationIntegrationHarness,
  expected: string,
) =>
  Effect.gen(function* () {
    const events = yield* harness.waitForDomainEvent(
      (event) =>
        event.type === "thread.message-sent" &&
        event.payload.role === "assistant" &&
        event.payload.text === expected,
    );
    const message = events.find(
      (event) =>
        event.type === "thread.message-sent" &&
        event.payload.role === "assistant" &&
        event.payload.text === expected,
    );
    if (!message || message.type !== "thread.message-sent")
      throw new Error("Missing expected peer text");
    // Observe the normal finalization boundary as well as the streamed text.
    // Neither the approval receipt nor an unflushed peer delta satisfies this.
    yield* harness.waitForDomainEvent(
      (event) =>
        event.type === "thread.message-sent" &&
        event.payload.messageId === message.payload.messageId &&
        event.payload.streaming === false,
    );
  });

const ApprovalInfo = Schema.Struct({
  requestId: Schema.String,
  detail: Schema.String,
  approvalScope: ApprovalScope,
  feedbackSupported: Schema.Literal(true),
});

const guardedCases = [
  { scenario: "success", route: "bridge" },
  { scenario: "stale-turn", route: "bridge" },
  { scenario: "lost-reply", route: "bridge" },
  { scenario: "scope-mismatch", route: "bridge" },
  { scenario: "success", route: "dispatch" },
  { scenario: "scope-mismatch", route: "dispatch" },
  { scenario: "child-success", route: "bridge" },
  { scenario: "child-stale", route: "bridge" },
] as const;
for (const { scenario, route } of guardedCases) {
  it.live(
    `correlates guarded ${scenario} through ${route}, reactor, actual Codex runtime, and scripted peer`,
    () =>
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        const actualSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const path = yield* Path.Path;
        const peer = path.join(
          import.meta.dirname,
          "../src/provider/testUtils/codexApprovalDecisionPeer.ts",
        );
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let responseCalls = 0;
        const scriptedSpawner = ChildProcessSpawner.make(() =>
          actualSpawner.spawn(ChildProcess.make(process.execPath, [peer, scenario])),
        );
        const harness = yield* makeOrchestrationIntegrationHarness({
          realCodex: true,
          codexRuntimeFactory: (options) =>
            makeCodexSessionRuntime({ ...options, binaryPath: process.execPath }).pipe(
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, scriptedSpawner),
              Effect.map((runtime) => ({
                ...runtime,
                respondToRequest: (
                  requestId: ApprovalRequestId,
                  decision: ProviderApprovalDecision,
                  context?: ApprovalDecisionContext,
                ) =>
                  Effect.gen(function* () {
                    responseCalls++;
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(release);
                    yield* runtime.respondToRequest(requestId, decision, context);
                  }),
              })),
            ),
        });
        yield* Effect.addFinalizer(() => harness.dispose);
        const base = {
          id: "guarded",
          binding: { runtimeId: "runtime", workItemId: "work", leaseGeneration: 1 },
        };
        const bound = yield* harness.siftBridge({
          ...base,
          operation: "bind",
          checkoutPath: harness.workspaceDir,
          runtimeMode: "approval-required",
          modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        });
        NodeAssert.ok(bound.ok && "threadId" in bound.result);
        const threadId = bound.result.threadId;
        yield* harness.siftBridge({
          ...base,
          operation: "turn",
          commandId: "turn",
          text: "Use only the synthetic peer.",
        });
        const events = yield* harness.waitForDomainEvent(
          (event) =>
            event.type === "thread.activity-appended" &&
            event.payload.activity.kind === "approval.requested",
        );
        const approvalEvent = events.find(
          (event) =>
            event.type === "thread.activity-appended" &&
            event.payload.activity.kind === "approval.requested",
        );
        if (!approvalEvent || approvalEvent.type !== "thread.activity-appended")
          throw new Error("No approval event");
        const approval = yield* Schema.decodeUnknownEffect(ApprovalInfo)(
          approvalEvent.payload.activity.payload,
        );
        // This peer supplies neither command nor reason. The host remains visible to the human.
        NodeAssert.equal(approval.detail, "Network target: https example.com");
        if (scenario === "child-success" || scenario === "child-stale")
          yield* waitForCompletedAssistantText(harness, "Child turn observation barrier.");
        const request = {
          ...base,
          operation: "approve",
          commandId: "decision",
          requestId: approval.requestId,
          attemptId: "attempt-1",
          decision: scenario === "scope-mismatch" ? "accept" : "decline",
          ...(scenario === "scope-mismatch"
            ? { expectedApprovalScope: { ...approval.approvalScope, digest: "0".repeat(64) } }
            : { feedback: "Use the retained local fixture." }),
        };
        const directCommand = {
          type: "thread.approval.respond" as const,
          commandId: CommandId.make("direct-decision"),
          threadId: ThreadId.make(threadId),
          requestId: ApprovalRequestId.make(approval.requestId),
          decision: scenario === "scope-mismatch" ? ("accept" as const) : ("decline" as const),
          createdAt: "2026-10-16T00:00:00.000Z",
          decisionContext: {
            commandId: "decision",
            attemptId: "attempt-1",
            ...(scenario === "scope-mismatch"
              ? { expectedApprovalScope: { ...approval.approvalScope, digest: "0".repeat(64) } }
              : { feedback: "Use the retained local fixture." }),
          },
        };
        const decide =
          route === "bridge"
            ? harness.siftBridge(request)
            : harness.engine.dispatch(directCommand).pipe(
                Effect.andThen(harness.readApprovalEffect(directCommand.commandId)),
                Effect.map((receipt) => ({
                  id: base.id,
                  ok: true as const,
                  result: { threadId, ...receipt },
                })),
              );
        const first = yield* decide;
        NodeAssert.equal(first.ok && first.result.state, "pending");
        yield* Deferred.await(entered);
        const pendingRetry = yield* decide;
        NodeAssert.equal(pendingRetry.ok && pendingRetry.result.state, "pending");
        NodeAssert.equal(responseCalls, 1);
        yield* Deferred.succeed(release, undefined);
        yield* harness.drainProviderCommands;
        const settled = yield* decide;
        if (scenario === "success" || scenario === "child-success") {
          NodeAssert.equal(settled.ok && settled.result.state, "accepted");
          yield* waitForCompletedAssistantText(
            harness,
            scenario === "child-success"
              ? 'Synthetic peer consumed native decline after steering. thread=child-thread turn=child-turn-1 feedback="Use the retained local fixture."'
              : 'Synthetic peer consumed native decline after steering. turn=turn-1 feedback="Use the retained local fixture."',
          );
          const resolved = yield* harness.waitForDomainEvent(
            (event) =>
              event.type === "thread.activity-appended" &&
              event.payload.activity.kind === "approval.resolved",
          );
          NodeAssert.ok(
            resolved.some(
              (event) =>
                event.type === "thread.activity-appended" &&
                event.payload.activity.kind === "approval.resolved" &&
                Schema.is(Schema.Struct({ feedbackDelivered: Schema.Literal(true) }))(
                  event.payload.activity.payload,
                ),
            ),
          );
        } else {
          const error =
            scenario === "scope-mismatch"
              ? "APPROVAL_SCOPE_MISMATCH"
              : scenario === "child-stale"
                ? "FEEDBACK_STALE_TURN"
                : "FEEDBACK_DELIVERY_UNKNOWN";
          NodeAssert.deepEqual(settled.ok && settled.result, {
            threadId: bound.ok && bound.result.threadId,
            state: "failed",
            error,
          });
          const failed = yield* harness.waitForDomainEvent(
            (event) =>
              event.type === "thread.activity-appended" &&
              event.payload.activity.kind === "provider.approval.respond.failed",
          );
          NodeAssert.ok(
            failed.some(
              (event) =>
                event.type === "thread.activity-appended" &&
                Schema.is(Schema.Struct({ errorCode: Schema.Literal(error) }))(
                  event.payload.activity.payload,
                ),
            ),
          );
        }
        NodeAssert.deepEqual(yield* decide, settled);
        NodeAssert.equal(responseCalls, 1, "Stable retries must not invoke runtime again");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

const commandCases = [
  { scenario: "command-accept", route: "bridge" },
  { scenario: "command-scope-mismatch", route: "bridge" },
  { scenario: "command-legacy", route: "bridge" },
  { scenario: "command-accept", route: "dispatch" },
] as const;
for (const { scenario, route } of commandCases) {
  it.live(
    `requires exact command authority before the fixture tool effect: ${scenario} via ${route}`,
    () =>
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        const actualSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "c3a-command-effect-" });
        const effectFile = path.join(tempDir, "approved-effect.txt");
        const fixtureProgram = path.join(tempDir, "node-fixture");
        yield* fs.symlink(process.execPath, fixtureProgram);
        const peer = path.join(
          import.meta.dirname,
          "../src/provider/testUtils/codexApprovalDecisionPeer.ts",
        );
        const scriptedSpawner = ChildProcessSpawner.make(() =>
          actualSpawner.spawn(
            ChildProcess.make(process.execPath, [peer, scenario, effectFile, fixtureProgram]),
          ),
        );
        let responseCalls = 0;
        const harness = yield* makeOrchestrationIntegrationHarness({
          realCodex: true,
          codexRuntimeFactory: (options) =>
            makeCodexSessionRuntime({ ...options, binaryPath: process.execPath }).pipe(
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, scriptedSpawner),
              Effect.map((runtime) => ({
                ...runtime,
                respondToRequest: (
                  requestId: ApprovalRequestId,
                  decision: ProviderApprovalDecision,
                  context?: ApprovalDecisionContext,
                ) => {
                  responseCalls++;
                  return runtime.respondToRequest(requestId, decision, context);
                },
              })),
            ),
        });
        yield* Effect.addFinalizer(() => harness.dispose);
        const base = {
          id: "command-effect",
          binding: { runtimeId: "runtime-command", workItemId: "work-command", leaseGeneration: 1 },
        };
        const bound = yield* harness.siftBridge({
          ...base,
          operation: "bind",
          checkoutPath: harness.workspaceDir,
          runtimeMode: "approval-required",
          modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        });
        NodeAssert.ok(bound.ok && "threadId" in bound.result);
        const threadId = bound.result.threadId;
        yield* harness.siftBridge({
          ...base,
          operation: "turn",
          commandId: "turn",
          text: "Use only the synthetic command peer.",
        });
        const events = yield* harness.waitForDomainEvent(
          (event) =>
            event.type === "thread.activity-appended" &&
            event.payload.activity.kind === "approval.requested",
        );
        const event = events.find(
          (item) =>
            item.type === "thread.activity-appended" &&
            item.payload.activity.kind === "approval.requested",
        );
        if (!event || event.type !== "thread.activity-appended")
          throw new Error("No command approval event");
        const approval = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            requestId: Schema.String,
            approvalScope: Schema.optional(ApprovalScope),
          }),
        )(event.payload.activity.payload);
        const persistedEvent = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          event,
        );
        NodeAssert.equal(
          persistedEvent.includes("siftCommandScope"),
          false,
          "Raw argv extension must not reach persisted activity",
        );
        NodeAssert.equal(
          yield* fs.exists(effectFile),
          false,
          "The peer must wait for approval before executing the fixture",
        );
        if (scenario !== "command-legacy")
          NodeAssert.equal(approval.approvalScope?.kind, "command");
        else NodeAssert.equal(approval.approvalScope, undefined);
        const expectedScope =
          scenario === "command-accept"
            ? approval.approvalScope
            : {
                version: 1 as const,
                kind: "command" as const,
                digest: "0".repeat(64),
              };
        const request = {
          ...base,
          operation: "approve",
          commandId: "effect-decision",
          requestId: approval.requestId,
          attemptId: "effect-attempt",
          decision: "accept",
          expectedApprovalScope: expectedScope,
          ruleSourceRequestId: "prior-exact-command-request",
        };
        const directCommand = {
          type: "thread.approval.respond" as const,
          commandId: CommandId.make("direct-effect-decision"),
          threadId: ThreadId.make(threadId),
          requestId: ApprovalRequestId.make(approval.requestId),
          decision: "accept" as const,
          createdAt: "2026-10-16T00:00:00.000Z",
          decisionContext: {
            commandId: "effect-decision",
            attemptId: "effect-attempt",
            ...(expectedScope ? { expectedApprovalScope: expectedScope } : {}),
            ruleSourceRequestId: "prior-exact-command-request",
          },
        };
        const decide =
          route === "bridge"
            ? harness.siftBridge(request)
            : harness.engine.dispatch(directCommand).pipe(
                Effect.andThen(harness.readApprovalEffect(directCommand.commandId)),
                Effect.map((receipt) => ({
                  id: base.id,
                  ok: true as const,
                  result: { threadId, ...receipt },
                })),
              );
        yield* decide;
        yield* harness.drainProviderCommands;
        const settled = yield* decide;
        if (scenario === "command-accept") {
          NodeAssert.equal(settled.ok && settled.result.state, "accepted");
          // An accepted response alone is insufficient: wait for the independently
          // executed child command, then inspect its exclusive-create file effect.
          yield* waitForCompletedAssistantText(harness, "Fixture tool effect completed.");
          const effect = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({
                effect: Schema.String,
                argv0: Schema.String,
              }),
            ),
          )(yield* fs.readFileString(effectFile));
          NodeAssert.deepEqual(effect, {
            effect: "approved fixture effect",
            argv0: "fixture-node-zero",
          });
        } else {
          NodeAssert.deepEqual(settled.ok && settled.result, {
            threadId: bound.ok && bound.result.threadId,
            state: "failed",
            error: "APPROVAL_SCOPE_MISMATCH",
          });
          NodeAssert.equal(yield* fs.exists(effectFile), false);
        }
        NodeAssert.deepEqual(yield* decide, settled);
        NodeAssert.equal(
          responseCalls,
          1,
          "Replaying a decision receipt must not release another command",
        );
        if (scenario === "command-accept" && route === "bridge") {
          const stale = yield* harness.siftBridge({ ...request, commandId: "different-decision" });
          NodeAssert.equal(stale.ok && stale.result.state, "failed");
          NodeAssert.equal(
            responseCalls,
            1,
            "An old decision ID must never reach the provider twice",
          );
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
