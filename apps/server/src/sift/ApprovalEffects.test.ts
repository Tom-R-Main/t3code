import * as NodeAssert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  beginApprovalEffect,
  ensureApprovalEffects,
  failQueuedApprovalEffect,
  finishApprovalEffect,
  readApprovalEffect,
  recoverApprovalEffects,
  reserveApprovalEffect,
} from "./ApprovalEffects.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("guarded effect receipts", (it) => {
  it.effect("reserves once, reports pending before execution, and retains exact success", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* ensureApprovalEffects(sql);
      NodeAssert.equal(yield* reserveApprovalEffect(sql, "success", "request", false), true);
      NodeAssert.equal(yield* reserveApprovalEffect(sql, "success", "request", false), false);
      NodeAssert.deepEqual(yield* readApprovalEffect(sql, "success"), {
        state: "pending",
        sequence: 0,
      });
      NodeAssert.equal(yield* beginApprovalEffect(sql, "success"), true);
      NodeAssert.equal(yield* beginApprovalEffect(sql, "success"), false);
      yield* finishApprovalEffect(sql, "success");
      NodeAssert.deepEqual(yield* readApprovalEffect(sql, "success"), {
        state: "accepted",
        sequence: 0,
      });
    }),
  );
  it.effect("retains unknown effects across reactor restart instead of replaying", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* ensureApprovalEffects(sql);
      for (const feedback of [true, false]) {
        const id = `crash-${feedback}`;
        yield* reserveApprovalEffect(sql, id, "request", feedback);
        yield* beginApprovalEffect(sql, id);
        yield* recoverApprovalEffects(sql);
        NodeAssert.equal(yield* beginApprovalEffect(sql, id), false);
        NodeAssert.deepEqual(yield* readApprovalEffect(sql, id), {
          state: "failed",
          error: feedback ? "FEEDBACK_DELIVERY_UNKNOWN" : "APPROVAL_EFFECT_UNKNOWN",
        });
      }
    }),
  );
  it.effect("terminalizes reservations left before durable dispatch on restart", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* ensureApprovalEffects(sql);
      for (const feedback of [true, false]) {
        const id = `queued-crash-${feedback}`;
        yield* reserveApprovalEffect(sql, id, "request", feedback);
        yield* recoverApprovalEffects(sql);
        NodeAssert.equal(yield* reserveApprovalEffect(sql, id, "request", feedback), false);
        NodeAssert.equal(yield* beginApprovalEffect(sql, id), false);
        NodeAssert.deepEqual(yield* readApprovalEffect(sql, id), {
          state: "failed",
          error: feedback ? "FEEDBACK_DELIVERY_UNKNOWN" : "APPROVAL_EFFECT_UNKNOWN",
        });
      }
    }),
  );
  it.effect("dispatch failure finalizes only queued receipts", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* ensureApprovalEffects(sql);
      yield* reserveApprovalEffect(sql, "dispatch-failed", "request", false);
      yield* failQueuedApprovalEffect(sql, "dispatch-failed");
      NodeAssert.equal(yield* beginApprovalEffect(sql, "dispatch-failed"), false);
      NodeAssert.deepEqual(yield* readApprovalEffect(sql, "dispatch-failed"), {
        state: "failed",
        error: "APPROVAL_EFFECT_UNKNOWN",
      });
      yield* reserveApprovalEffect(sql, "already-executing", "request", true);
      yield* beginApprovalEffect(sql, "already-executing");
      yield* failQueuedApprovalEffect(sql, "already-executing");
      yield* finishApprovalEffect(sql, "already-executing");
      NodeAssert.deepEqual(yield* readApprovalEffect(sql, "already-executing"), {
        state: "accepted",
        sequence: 0,
      });
    }),
  );
});
