// @effect-diagnostics nodeBuiltinImport:off
import * as Assert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import { deliverDeclineFeedback, makeDeclineFeedbackJournal } from "./CodexApprovalDecision.ts";

const layer = Layer.mergeAll(NodeServices.layer, NodeSqliteClient.layer({ filename: ":memory:" }));
it.layer(layer)("Codex feedback protocol peer", (it) => {
  for (const scenario of ["success", "stale-turn", "lost-reply"] as const) {
    it.effect(`handles ${scenario} without a replacement turn or repeated steering`, () =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const path = yield* Path.Path;
        const peer = path.join(import.meta.dirname, "../testUtils/codexApprovalDecisionPeer.ts");
        const handle = yield* spawner.spawn(ChildProcess.make(process.execPath, [peer, scenario]));
        const clientContext = yield* Layer.buildWithScope(CodexClient.layerChildProcess(handle), yield* Scope.Scope);
        yield* Effect.gen(function* () {
          const client = yield* CodexClient.CodexAppServerClient;
          const pending = yield* Deferred.make<void>();
          const nativeDecision = yield* Deferred.make<"decline">();
          yield* client.handleServerRequest("item/commandExecution/requestApproval", () =>
            Deferred.succeed(pending, undefined).pipe(
              Effect.andThen(Deferred.await(nativeDecision)),
              Effect.map((decision) => ({ decision })),
            ),
          );
          const begun = yield* client.raw.request("fixture/begin", {}).pipe(Effect.forkChild);
          yield* Deferred.await(pending);
          const sql = yield* SqlClient.SqlClient;
          const input = {
            client, journal: makeDeclineFeedbackJournal(sql), requestId: `peer-${scenario}`,
            providerThreadId: "provider-thread", pendingTurnId: "turn-1",
            activeTurnId: Effect.succeed("turn-1"),
            context: { commandId: `command-${scenario}`, attemptId: "attempt-1", feedback: "Use the local fixture." },
          };
          if (scenario === "success") {
            yield* deliverDeclineFeedback(input);
            // This is the only place the caller releases the native response.
            yield* Deferred.succeed(nativeDecision, "decline");
            Assert.deepEqual(yield* Fiber.join(begun), { events: ["steer", "decline"] });
            yield* deliverDeclineFeedback({ ...input, journal: makeDeclineFeedbackJournal(sql) });
          } else {
            Assert.equal((yield* Effect.flip(deliverDeclineFeedback(input))).code, "FEEDBACK_DELIVERY_UNKNOWN");
            Assert.equal((yield* Effect.flip(deliverDeclineFeedback({
              ...input, journal: makeDeclineFeedbackJournal(sql),
            }))).code, "FEEDBACK_DELIVERY_UNKNOWN");
            yield* Fiber.interrupt(begun);
          }
        }).pipe(Effect.provide(clientContext));
      }).pipe(Effect.scoped),
    );
  }
});
