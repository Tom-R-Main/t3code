// @effect-diagnostics nodeBuiltinImport:off
// Standalone synthetic provider process for cross-repository bridge contract
// tests. It uses real orchestration/provider/checkpoint reactors and a temporary
// SQLite/git workspace. It never loads provider credentials or starts a model.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EventId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SiftBridgeRequest } from "../../../packages/contracts/src/siftBridge.ts";
import { makeOrchestrationIntegrationHarness } from "./OrchestrationEngineHarness.integration.ts";
import { listenEffectSiftSocket } from "../src/sift/Socket.ts";

import { readSiftPublicKey } from "../src/sift/Authorization.ts";

const decodeRequest = Schema.decodeUnknownEffect(SiftBridgeRequest);

const program = Effect.gen(function* () {
  const encodedKey = process.env.T3_SIFT_BRIDGE_PUBLIC_KEY;
  if (!encodedKey) throw new Error("Fixture requires T3_SIFT_BRIDGE_PUBLIC_KEY.");
  const publicKey = readSiftPublicKey(encodedKey);
  const harness = yield* makeOrchestrationIntegrationHarness();
  yield* Effect.addFinalizer(() => harness.dispose);
  const socketPath = `${harness.rootDir}/sift.sock`;
  let threadId: ThreadId | undefined;
  const queued = new Set<string>();
  const handle = Effect.fn("SiftBridgeFixture.handle")(function* (
    input: unknown,
    authorize?: () => void,
  ) {
    const request = yield* decodeRequest(input);
    if (request.operation === "turn" && threadId && !queued.has(request.commandId)) {
      queued.add(request.commandId);
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const base = (id: string) => ({
        eventId: EventId.make(`${request.commandId}-${id}`),
        provider: ProviderDriverKind.make("codex"),
        threadId: threadId!,
        turnId: "fixture-turn",
        createdAt,
      });
      const response = {
        events: [
          { ...base("start"), type: "turn.started" },
          {
            ...base("approval"),
            type: "approval.requested",
            requestId: `${request.commandId}-approval`,
            requestKind: "command",
            detail: "Synthetic fixture approval",
          },
          {
            ...base("question"),
            type: "user-input.requested",
            requestId: `${request.commandId}-question`,
            payload: {
              questions: [
                {
                  id: "choice",
                  header: "Choice",
                  question: "Choose an option.",
                  options: [{ label: "first", description: "First option" }],
                },
              ],
            },
          },
          {
            ...base("message"),
            type: "message.delta",
            delta: "Sift bridge fixture completed the assignment.",
          },
          { ...base("done"), type: "turn.completed", status: "completed" },
        ],
      };
      if (harness.adapterHarness!.listActiveSessionIds().includes(threadId)) {
        yield* harness.adapterHarness!.queueTurnResponse(threadId, response);
      } else {
        yield* harness.adapterHarness!.queueTurnResponseForNextSession(response);
      }
    }
    const result = yield* harness.siftBridge(request, authorize);
    if (request.operation === "bind" && result.ok) threadId = ThreadId.make(result.result.threadId);
    return result;
  });
  yield* Effect.acquireRelease(
    Effect.promise(() => listenEffectSiftSocket(socketPath, handle, publicKey)),
    (close) => Effect.promise(close),
  );
  yield* Effect.sync(() =>
    process.stdout.write(
      // @effect-diagnostics-next-line preferSchemaOverJson:off - one-line ready record read by the cross-repo test harness.
      JSON.stringify({
        type: "ready",
        pid: process.pid,
        socketPath,
        checkoutPath: harness.workspaceDir,
      }) + "\n",
    ),
  );
  return yield* Effect.never;
});
program.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
