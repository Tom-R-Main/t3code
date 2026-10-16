import * as Assert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import type { ApprovalDecisionContext } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe } from "vite-plus/test";
import * as CodexSchema from "effect-codex-app-server/schema";
import {
  assertApprovalScope,
  codexNetworkApprovalScope,
  codexNetworkApprovalTarget,
  codexCommandApprovalScope,
  codexApprovalPublicPayload,
  CodexApprovalDecisionError,
  deliverDeclineFeedback,
  makeDeclineFeedbackJournal,
} from "./CodexApprovalDecision.ts";

const payload: CodexSchema.CommandExecutionRequestApprovalParams = {
  threadId: "provider-thread", turnId: "turn-1", itemId: "item-1", startedAtMs: 1,
  command: "display text is not authoritative argv", cwd: "/workspace",
  networkApprovalContext: { host: "Example.COM.", protocol: "https" },
};
const context: ApprovalDecisionContext = {
  commandId: "command-1", attemptId: "attempt-1", feedback: "Use the retained local fixture instead.",
};

describe("Codex exact network approval authority", () => {
  it("canonicalizes a typed host while preserving session, environment, and protocol", () => {
    const first = codexNetworkApprovalScope("session-1", payload)!;
    Assert.match(first.digest, /^[a-f0-9]{64}$/);
    Assert.deepEqual(first, codexNetworkApprovalScope("session-1", {
      ...payload, networkApprovalContext: { host: "example.com", protocol: "https" },
    }));
    for (const changed of [
      codexNetworkApprovalScope("session-2", payload),
      codexNetworkApprovalScope("session-1", { ...payload, environmentId: "other" }),
      codexNetworkApprovalScope("session-1", { ...payload, networkApprovalContext: { host: "example.net", protocol: "https" } }),
      codexNetworkApprovalScope("session-1", { ...payload, networkApprovalContext: { host: "example.com", protocol: "http" } }),
    ]) Assert.throws(() => assertApprovalScope(first, changed), /APPROVAL_SCOPE_MISMATCH/);
    Assert.throws(() => assertApprovalScope(first, undefined), /APPROVAL_SCOPE_MISMATCH/);
    // A literal internal host is still exact authority; URL-shaped strings are
    // rejected separately rather than forbidding legitimate single-label hosts.
    Assert.equal(codexNetworkApprovalScope("session-1", {
      ...payload, networkApprovalContext: { host: "simple", protocol: "https" },
    })?.kind, "network");
  });

  it("does not reinterpret V2 command strings, display actions, or policy prefixes as exact argv", () => {
    Assert.equal(codexNetworkApprovalScope("session-1", {
      ...payload, networkApprovalContext: null, proposedExecpolicyAmendment: ["git"],
    }), undefined);
    for (const host of ["https://example.com", "*.example.com", "example.com/path", "example.com:443", "user@example.com", "",
      "example.com?query", "example.com#fragment", "example.com\\path", "%65xample.com", "example.com\n", " example.com"]) {
      const input = { ...payload, networkApprovalContext: { host, protocol: "https" as const } };
      Assert.equal(codexNetworkApprovalScope("session-1", input), undefined, `Invalid host: ${JSON.stringify(host)}`);
      Assert.equal(codexNetworkApprovalTarget(input), undefined, `Invalid target display: ${JSON.stringify(host)}`);
    }
  });
});

describe("Codex authoritative command approval authority", () => {
  const commandPayload = {
    ...payload, networkApprovalContext: null,
    siftCommandScope: { version: 1, program: "/usr/bin/git", argv: ["git", "show", "--", "one two"], cwd: "/workspace" },
  };

  it("binds the literal argv vector, cwd, environment and session incarnation", () => {
    const first = codexCommandApprovalScope("session-1", commandPayload)!;
    Assert.equal(first.kind, "command");
    Assert.deepEqual(first, codexCommandApprovalScope("session-1", {
      ...commandPayload, command: "entirely different display text", commandActions: [],
      proposedExecpolicyAmendment: ["anything"],
    }));
    for (const changed of [
      codexCommandApprovalScope("session-2", commandPayload),
      codexCommandApprovalScope("session-1", { ...commandPayload, siftCommandScope: {
        ...commandPayload.siftCommandScope, program: "/other/git",
      } }),
      codexCommandApprovalScope("session-1", { ...commandPayload, siftCommandScope: {
        ...commandPayload.siftCommandScope, argv: ["different-argv-zero", "show", "--", "one two"],
      } }),
      codexCommandApprovalScope("session-1", { ...commandPayload, environmentId: "remote" }),
      codexCommandApprovalScope("session-1", { ...commandPayload, siftCommandScope: {
        ...commandPayload.siftCommandScope, argv: ["git", "show", "--", "one", "two"],
      } }),
      codexCommandApprovalScope("session-1", { ...commandPayload, siftCommandScope: {
        ...commandPayload.siftCommandScope, argv: ["git", "show", "--", "one two "],
      } }),
      codexCommandApprovalScope("session-1", { ...commandPayload, siftCommandScope: {
        ...commandPayload.siftCommandScope, cwd: "/workspace/other",
      } }),
      codexCommandApprovalScope("session-1", { ...commandPayload, siftCommandScope: {
        ...commandPayload.siftCommandScope, cwd: "/workspace/.",
      } }),
    ]) Assert.throws(() => assertApprovalScope(first, changed), /APPROVAL_SCOPE_MISMATCH/);
  });

  it("displays canonical program, literal argv and cwd instead of a mismatched shell preview", () => {
    const exact = { version: 1, program: "/usr/bin/tool", argv: ["custom-zero", "one two", "a\"b", "line\nbreak", "\t"], cwd: "/workspace/a b" };
    const original = { ...commandPayload, command: "misleading display command", siftCommandScope: exact };
    const projected = codexApprovalPublicPayload(original);
    Assert.equal(projected.command, `Program: ${JSON.stringify(exact.program)}\nArguments (argv): ${JSON.stringify(exact.argv)}\nWorking directory: ${JSON.stringify(exact.cwd)}`);
    Assert.equal("siftCommandScope" in projected, false);
    Assert.equal("commandActions" in projected, false);
    Assert.ok(codexCommandApprovalScope("session-1", original));
    for (const changed of [
      { ...exact, argv: ["custom-zero", "x".repeat(4096)] },
      { ...exact, argv: ["custom-zero", "Bearer fixture-secret-value"] },
    ]) {
      const input = { ...commandPayload, siftCommandScope: changed };
      Assert.equal(codexCommandApprovalScope("session-1", input), undefined);
      Assert.equal(codexApprovalPublicPayload(input).command?.includes("fixture-secret-value"), false);
    }
  });

  it("preserves valid Unicode pairs and distinct literal replacement characters", () => {
    const scope = { ...commandPayload.siftCommandScope, argv: ["git", "\ud83d\ude80"] };
    const unicode = codexCommandApprovalScope("session-1", { ...commandPayload, siftCommandScope: scope });
    Assert.ok(unicode);
    Assert.notDeepEqual(unicode, codexCommandApprovalScope("session-1", {
      ...commandPayload, siftCommandScope: { ...scope, argv: ["git", "\ufffd"] },
    }));
  });

  it("keeps legacy and malformed providers one-time only and never derives argv from display", () => {
    for (const extension of [undefined, null, {}, { version: 2, program: "/usr/bin/git", argv: ["git"], cwd: "/workspace" },
      { version: 1, program: "/usr/bin/git", argv: [], cwd: "/workspace" },
      { version: 1, program: "", argv: ["git"], cwd: "/workspace" },
      { version: 1, program: "/usr/bin/git", argv: ["git\0show"], cwd: "/workspace" },
      { version: 1, program: "/usr/bin/git", argv: "git show", cwd: "/workspace" },
      { version: 1, program: "/usr/bin/git", argv: ["git"], cwd: "relative" },
      { version: 1, program: "/usr/bin/git", argv: ["git"], cwd: "/workspace\0" },
      { version: 1, program: "/usr/bin/git", argv: Array.from({ length: 257 }, () => "git"), cwd: "/workspace" },
      { version: 1, program: "relative/tool", argv: ["tool"], cwd: "/workspace" },
      { version: 1, program: "/usr/bin/git", argv: [""], cwd: "/workspace" },
      ...["\ud800", "\udfff"].flatMap((invalid) => [
        { version: 1, program: `/usr/bin/${invalid}`, argv: ["git"], cwd: "/workspace" },
        { version: 1, program: "/usr/bin/git", argv: ["git", invalid], cwd: "/workspace" },
        { version: 1, program: "/usr/bin/git", argv: ["git"], cwd: `/workspace/${invalid}` },
      ]),
    ]) Assert.equal(codexCommandApprovalScope("session-1", {
      ...commandPayload, siftCommandScope: extension,
    }), undefined);
    Assert.equal(codexCommandApprovalScope("", commandPayload), undefined);
    Assert.equal(codexCommandApprovalScope("session-1", { ...commandPayload,
      networkApprovalContext: { host: "example.com", protocol: "https" },
    }), undefined);
    Assert.equal("siftCommandScope" in codexApprovalPublicPayload(commandPayload), false);
  });
});

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("durable decline feedback", (it) => {
  it.effect("steers the existing turn before the caller releases native decline; a known delivery is not repeated", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const calls: string[] = [];
      const input: Parameters<typeof deliverDeclineFeedback>[0] = {
        journal: makeDeclineFeedbackJournal(sql), requestId: "request-success",
        providerThreadId: "provider-thread", pendingTurnId: "turn-1",
        activeTurnId: Effect.succeed("turn-1"), context,
        client: { request: (method, params) => {
          Assert.equal(method, "turn/steer");
          const steer = Schema.decodeUnknownSync(CodexSchema.V2TurnSteerParams)(params);
          Assert.equal(steer.expectedTurnId, "turn-1");
          Assert.equal(steer.threadId, "provider-thread");
          Assert.equal(steer.input[0]?.type, "text");
          calls.push(method);
          return Effect.succeed({ turnId: "turn-1" });
        } } as Parameters<typeof deliverDeclineFeedback>[0]["client"],
      };
      yield* deliverDeclineFeedback(input);
      calls.push("native-decline");
      yield* deliverDeclineFeedback({ ...input, journal: makeDeclineFeedbackJournal(sql) });
      Assert.deepEqual(calls, ["turn/steer", "native-decline"]);
    }),
  );

  it.effect("rejects a stale pending turn before transport or journal reservation", () =>
    Effect.gen(function* () {
      const journal = makeDeclineFeedbackJournal(yield* SqlClient.SqlClient);
      const error = yield* Effect.flip(deliverDeclineFeedback({
        journal, requestId: "request-stale", providerThreadId: "provider-thread",
        pendingTurnId: "turn-1", activeTurnId: Effect.succeed("turn-2"), context,
        client: { request: () => Effect.die("Unexpected provider request") },
      }));
      Assert.equal(error.code, "FEEDBACK_STALE_TURN");
      Assert.equal(yield* journal.reserve("request-stale", context), "new");
    }),
  );

  for (const outcome of ["lost-reply", "wrong-turn"] as const) {
    it.effect(`does not repeat steering after ${outcome}, including a fresh journal instance`, () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        let calls = 0;
        const input: Parameters<typeof deliverDeclineFeedback>[0] = {
          journal: makeDeclineFeedbackJournal(sql), requestId: `request-${outcome}`,
          providerThreadId: "provider-thread", pendingTurnId: "turn-1",
          activeTurnId: Effect.succeed("turn-1"), context,
          client: { request: () => {
            calls++;
            return outcome === "lost-reply"
              ? Effect.fail(new CodexApprovalDecisionError({ code: "transport-lost-after-send" }))
              : Effect.succeed({ turnId: "turn-2" });
          } } as Parameters<typeof deliverDeclineFeedback>[0]["client"],
        };
        Assert.equal((yield* Effect.flip(deliverDeclineFeedback(input))).code, "FEEDBACK_DELIVERY_UNKNOWN");
        Assert.equal((yield* Effect.flip(deliverDeclineFeedback({
          ...input, journal: makeDeclineFeedbackJournal(sql),
        }))).code, "FEEDBACK_DELIVERY_UNKNOWN");
        Assert.equal(calls, 1);
      }),
    );
  }

  it.effect("rejects changed feedback or command identity for the same request", () =>
    Effect.gen(function* () {
      const journal = makeDeclineFeedbackJournal(yield* SqlClient.SqlClient);
      yield* journal.reserve("request-conflict", context);
      for (const changed of [{ ...context, feedback: "Different" }, { ...context, commandId: "other" }]) {
        Assert.equal((yield* Effect.flip(journal.reserve("request-conflict", changed))).code, "FEEDBACK_COMMAND_CONFLICT");
      }
    }),
  );
});
