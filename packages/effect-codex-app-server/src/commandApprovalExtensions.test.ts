import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { CodexAppServerRequestError } from "./errors.ts";
import { CommandApprovalParams } from "./commandApprovalExtensions.ts";

it("retains the optional fork extension through the typed request decoder", () => {
  const base = { threadId: "thread", turnId: "turn", itemId: "item", startedAtMs: 1 };
  const extension = { version: 1, program: "git", argv: ["git", "show"], cwd: "/workspace" };
  const decode = Schema.decodeUnknownSync(CommandApprovalParams);
  assert.deepEqual(decode({ ...base, siftCommandScope: extension }).siftCommandScope, extension);
  assert.deepEqual(decode(base), base);
  // Invalid extensions cannot create reusable authority, but do not strand the
  // old provider's one-time approval callback at the transport decoder.
  assert.deepEqual(decode({ ...base, siftCommandScope: "invalid" }).siftCommandScope, "invalid");
});

it.effect("keeps malformed-envelope errors free of raw command scope operands", () =>
  Effect.gen(function* () {
    const marker = "fixture-private-operand";
    const error = yield* Effect.flip(
      Schema.decodeUnknownEffect(CommandApprovalParams)({
        threadId: "thread",
        turnId: "turn",
        itemId: null,
        startedAtMs: 1,
        siftCommandScope: { version: 1, program: marker, argv: [marker], cwd: "/workspace" },
      }),
    );
    const response = CodexAppServerRequestError.invalidPayload(
      "item/commandExecution/requestApproval",
      "decode-payload",
      error,
    ).toProtocolError();
    assert.equal(response.code, -32602);
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(response);
    assert.equal(encoded.includes(marker), false);
  }),
);
