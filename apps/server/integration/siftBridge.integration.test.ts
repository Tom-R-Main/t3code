// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import { canonicalSiftAuthorization } from "../src/sift/Authorization.ts";
import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import { EventId, ProviderDriverKind, ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { makeOrchestrationIntegrationHarness } from "./OrchestrationEngineHarness.integration.ts";
import { listenEffectSiftSocket } from "../src/sift/Socket.ts";
import { gitShowFileAtRef } from "./OrchestrationEngineHarness.integration.ts";
import { checkpointRefForThreadTurn } from "../src/checkpointing/Utils.ts";

it.live(
  "runs socket commands through provider reactors and exports durable assistant/checkpoint evidence",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeOrchestrationIntegrationHarness();
      yield* Effect.addFinalizer(() => harness.dispose);
      const keys = NodeCrypto.generateKeyPairSync("ed25519");
      const socketPath = `${harness.rootDir}/sift.sock`;
      yield* Effect.acquireRelease(
        Effect.promise(() =>
          listenEffectSiftSocket(socketPath, harness.siftBridge, keys.publicKey),
        ),
        (close) => Effect.promise(close),
      );
      const send = (input: unknown) =>
        Effect.promise(
          () =>
            new Promise<Record<string, unknown>>((resolve, reject) => {
              const expiresAt = Date.now() + 30_000;
              const socket = NodeNet.createConnection(socketPath);
              let text = "";
              socket.on("connect", () =>
                socket.write(
                  JSON.stringify({
                    request: input,
                    authorization: {
                      expiresAt,
                      signature: NodeCrypto.sign(
                        null,
                        Buffer.from(canonicalSiftAuthorization(input, expiresAt)),
                        keys.privateKey,
                      ).toString("base64url"),
                    },
                  }) + "\n",
                ),
              );
              socket.on("error", reject);
              socket.on("data", (data) => {
                text += data.toString();
              });
              socket.on("end", () => resolve(JSON.parse(text)));
            }),
        );
      const base = {
        id: "integration",
        binding: { runtimeId: "runtime", workItemId: "work", leaseGeneration: 1 },
      };
      const bound = yield* send({
        ...base,
        operation: "bind",
        checkoutPath: harness.workspaceDir,
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "approval-required",
      });
      assert.equal(bound.ok, true);
      const threadId = ThreadId.make((bound.result as { threadId: string }).threadId);
      const fixture = (eventId: string) => ({
        eventId: EventId.make(eventId),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        turnId: "fixture-turn",
        createdAt: "2026-09-04T20:00:00.000Z",
      });
      yield* harness.adapterHarness!.queueTurnResponseForNextSession({
        events: [
          { ...fixture("start"), type: "turn.started" },
          {
            ...fixture("approval"),
            type: "approval.requested",
            requestId: "approve-1",
            requestKind: "command",
            detail: "Synthetic command approval",
          },
          {
            ...fixture("question"),
            type: "user-input.requested",
            requestId: "question-1",
            payload: {
              questions: [
                {
                  id: "choice",
                  header: "Choice",
                  question: "Choose a fixture option.",
                  options: [{ label: "first", description: "First option" }],
                },
              ],
            },
          },
          { ...fixture("text"), type: "message.delta", delta: "Verified fixture response." },
          { ...fixture("complete"), type: "turn.completed", status: "completed" },
        ],
      });
      const turn = {
        ...base,
        operation: "turn",
        commandId: "turn-1",
        text: "Inspect the fixture.",
      };
      const accepted = yield* send(turn);
      assert.equal(accepted.ok, true);
      assert.equal((accepted.result as { state: string }).state, "accepted");
      const receipt = yield* harness.waitForReceipt(
        (receipt) => receipt.type === "checkpoint.diff.finalized" && receipt.threadId === threadId,
      );
      assert.equal(receipt.type, "checkpoint.diff.finalized");
      yield* harness.waitForReceipt(
        (receipt) => receipt.type === "turn.processing.quiesced" && receipt.threadId === threadId,
      );
      const approved = yield* send({
        ...base,
        operation: "approve",
        commandId: "approval-1",
        requestId: "approve-1",
        decision: "accept",
      });
      assert.equal(approved.ok, true);
      yield* harness.waitForPendingApproval(
        "approve-1",
        (row) => row.status === "resolved" && row.decision === "accept",
      );
      const answered = yield* send({
        ...base,
        operation: "answer",
        commandId: "answer-1",
        requestId: "question-1",
        answers: { choice: "first" },
      });
      assert.equal(answered.ok, true);
      const duplicate = yield* send({ ...turn, id: "duplicate" });
      assert.deepEqual(duplicate.result, accepted.result);
      const events = yield* send({ ...base, operation: "events", afterSequence: 0 });
      assert.equal(events.ok, true);
      assert.ok(JSON.stringify(events.result).includes("Verified fixture response."));
      const messageEvents = (events.result as { events: OrchestrationEvent[] }).events.filter(
        (event) => event.type === "thread.message-sent" && event.payload.role === "assistant",
      );
      const messages = new Map<string, string>();
      const completed = new Map<string, string>();
      for (const event of messageEvents) {
        if (event.type !== "thread.message-sent") continue;
        const payload = event.payload;
        const previous = messages.get(payload.messageId) ?? "";
        const text = payload.streaming ? previous + payload.text : payload.text || previous;
        messages.set(payload.messageId, text);
        if (!payload.streaming) completed.set(payload.messageId, text);
      }
      assert.deepEqual([...completed.values()], ["Verified fixture response."]);
      assert.ok(
        messageEvents.some(
          (event) =>
            event.type === "thread.message-sent" &&
            !event.payload.streaming &&
            event.payload.text === "",
        ),
      );
      const projected = Option.getOrThrow(
        yield* harness.snapshotQuery.getThreadDetailById(threadId),
      );
      assert.deepEqual(
        projected.messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.text),
        [...completed.values()],
      );
      assert.equal(
        gitShowFileAtRef(
          harness.workspaceDir,
          checkpointRefForThreadTurn(threadId, 1),
          "README.md",
        ),
        "v1\n",
      );
      const stopped = yield* send({ ...base, operation: "stop", commandId: "stop-1" });
      assert.equal(stopped.ok, true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
