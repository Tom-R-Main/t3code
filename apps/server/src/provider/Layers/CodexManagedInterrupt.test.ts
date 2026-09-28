import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { assert, describe } from "vite-plus/test";
import { makeManagedCommandOwnership } from "./CodexManagedInterrupt.ts";

const item = (id: string, threadId = "root", turnId = "turn") => ({
  threadId,
  turnId,
  item: { type: "commandExecution", id },
});

describe("managed command ownership", () => {
  for (const priorProcess of [false, true]) {
    it.effect(
      `declined approval only proves no process when none was observed: ${priorProcess}`,
      () =>
        Effect.gen(function* () {
          const ownership = makeManagedCommandOwnership();
          ownership.observe("item/started", {
            ...item("approval"),
            item: {
              id: "approval",
              type: "commandExecution",
              processId: priorProcess ? "1" : null,
            },
          });
          ownership.observe("item/completed", {
            ...item("approval"),
            item: {
              id: "approval",
              type: "commandExecution",
              status: "declined",
              exitCode: null,
              processId: null,
            },
          });
          ownership.observe("turn/completed", {
            threadId: "root",
            turn: { id: "turn", status: "interrupted" },
          });
          const result = yield* ownership.cleanup(
            { request: () => Effect.succeed({ data: [] }) },
            ownership.targets("root", "turn"),
            "root",
          );
          assert.equal(result.confirmed, !priorProcess);
        }),
    );
  }
  it.effect("does not accept an interrupt acknowledgment without a terminal receipt", () =>
    Effect.gen(function* () {
      const ownership = makeManagedCommandOwnership();
      ownership.observe("turn/started", { threadId: "root", turn: { id: "turn" } });
      const targets = ownership.targets("root", "turn");
      let listed = false;
      const result = yield* ownership.cleanup(
        {
          request: () =>
            Effect.sync(() => {
              listed = true;
              return { data: [] };
            }),
        },
        targets,
        "root",
      );
      assert.isFalse(result.confirmed);
      assert.isFalse(listed);
      const waiting = yield* ownership
        .awaitTerminals(targets)
        .pipe(Effect.result, Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      assert.equal((yield* Fiber.join(waiting))._tag, "Failure");
    }),
  );

  it.effect(
    "cleans a completed child from this assignment and preserves a live older assignment",
    () =>
      Effect.gen(function* () {
        const ownership = makeManagedCommandOwnership();
        for (const [child, parentTurn] of [
          ["old-child", "old-turn"],
          ["current-child", "turn"],
        ]) {
          ownership.observe("thread/started", {
            thread: {
              id: child,
              source: { subAgent: { thread_spawn: { parent_thread_id: "root" } } },
            },
          });
          ownership.observe("item/completed", {
            threadId: "root",
            turnId: parentTurn,
            item: {
              id: `spawn-${child}`,
              type: "subAgentActivity",
              kind: "started",
              agentThreadId: child,
            },
          });
          ownership.observe("turn/started", { threadId: child, turn: { id: `${child}-turn` } });
          ownership.observe("item/started", item(`${child}-command`, child, `${child}-turn`));
        }
        ownership.observe("turn/completed", {
          threadId: "current-child",
          turn: { id: "current-child-turn", status: "completed" },
        });
        ownership.observe("turn/completed", {
          threadId: "root",
          turn: { id: "turn", status: "interrupted" },
        });
        const targets = ownership.targets("root", "turn");
        assert.isFalse(targets.has("old-child"));
        assert.equal(targets.get("current-child"), "current-child-turn");
        let present = true;
        const calls: unknown[] = [];
        const client = {
          request: (method: string, params?: unknown) =>
            Effect.sync(() => {
              if (method.endsWith("/list"))
                return {
                  data:
                    (params as { threadId: string }).threadId === "current-child" && present
                      ? [{ itemId: "current-child-command", processId: "1" }]
                      : [],
                };
              calls.push(params);
              present = false;
              return { terminated: true };
            }),
        };
        assert.isTrue((yield* ownership.cleanup(client, targets, "root")).confirmed);
        assert.deepEqual(calls, [{ threadId: "current-child", processId: "1" }]);
      }),
  );
  const spawnChild = (
    ownership: ReturnType<typeof makeManagedCommandOwnership>,
    child: string,
    parent: string,
    parentTurn: string,
  ) => {
    ownership.observe("thread/started", {
      thread: {
        id: child,
        source: { subAgent: { thread_spawn: { parent_thread_id: parent } } },
      },
    });
    ownership.observe("item/completed", {
      threadId: parent,
      turnId: parentTurn,
      item: {
        id: `spawn-${child}`,
        type: "subAgentActivity",
        kind: "started",
        agentThreadId: child,
      },
    });
    ownership.observe("turn/started", { threadId: child, turn: { id: `${child}-turn` } });
  };
  const interacted = (threadId: string, turnId: string, agentThreadId: string) => ({
    threadId,
    turnId,
    item: {
      id: `interact-${threadId}-${agentThreadId}`,
      type: "subAgentActivity",
      kind: "interacted",
      agentThreadId,
    },
  });

  // Captured in codexMultiAgentWire.json: a child reports back to its root.
  it.effect("a child's interaction with its ancestor keeps ownership verified", () =>
    Effect.gen(function* () {
      const ownership = makeManagedCommandOwnership();
      spawnChild(ownership, "child", "root", "turn");
      spawnChild(ownership, "grandchild", "child", "child-turn");
      ownership.observe("item/started", item("child-command", "child", "child-turn"));
      ownership.observe("item/completed", interacted("child", "child-turn", "root"));
      ownership.observe("item/completed", interacted("grandchild", "grandchild-turn", "root"));
      assert.isTrue(ownership.verified("root"));
      ownership.observe("turn/completed", {
        threadId: "child",
        turn: { id: "child-turn", status: "interrupted" },
      });
      ownership.observe("turn/completed", {
        threadId: "grandchild",
        turn: { id: "grandchild-turn", status: "interrupted" },
      });
      ownership.observe("turn/completed", {
        threadId: "root",
        turn: { id: "turn", status: "interrupted" },
      });
      const targets = ownership.targets("root", "turn");
      assert.equal(targets.get("child"), "child-turn");
      let present = true;
      const calls: unknown[] = [];
      const client = {
        request: (method: string, params?: unknown) =>
          Effect.sync(() => {
            if (method.endsWith("/list"))
              return {
                data:
                  (params as { threadId: string }).threadId === "child" && present
                    ? [{ itemId: "child-command", processId: "7" }]
                    : [],
              };
            calls.push(params);
            present = false;
            return { terminated: true };
          }),
      };
      assert.isTrue((yield* ownership.cleanup(client, targets, "root")).confirmed);
      assert.deepEqual(calls, [{ threadId: "child", processId: "7" }]);
    }),
  );

  it.effect("reassigning an older child or messaging an unknown thread still fails closed", () =>
    Effect.sync(() => {
      const reassigned = makeManagedCommandOwnership();
      spawnChild(reassigned, "child", "root", "old-turn");
      reassigned.observe("item/completed", interacted("root", "turn", "child"));
      assert.isFalse(reassigned.verified("root"));
      const unknown = makeManagedCommandOwnership();
      spawnChild(unknown, "child", "root", "turn");
      unknown.observe("item/completed", interacted("child", "child-turn", "stranger"));
      assert.isFalse(unknown.verified("root"));
    }),
  );

  it.effect("a failed child turn is terminal proof and its outstanding command is cleaned", () =>
    Effect.gen(function* () {
      const ownership = makeManagedCommandOwnership();
      spawnChild(ownership, "child", "root", "turn");
      ownership.observe("item/started", item("child-command", "child", "child-turn"));
      ownership.observe("turn/completed", {
        threadId: "child",
        turn: { id: "child-turn", status: "failed" },
      });
      ownership.observe("turn/completed", {
        threadId: "root",
        turn: { id: "turn", status: "interrupted" },
      });
      const targets = ownership.targets("root", "turn");
      assert.equal(targets.get("child"), "child-turn");
      assert.isTrue(ownership.completed("child", "child-turn"));
      yield* ownership.awaitTerminals(targets);
      let present = true;
      const calls: unknown[] = [];
      const client = {
        request: (method: string, params?: unknown) =>
          Effect.sync(() => {
            if (method.endsWith("/list"))
              return {
                data:
                  (params as { threadId: string }).threadId === "child" && present
                    ? [{ itemId: "child-command", processId: "9" }]
                    : [],
              };
            calls.push(params);
            present = false;
            return { terminated: true };
          }),
      };
      assert.isTrue((yield* ownership.cleanup(client, targets, "root")).confirmed);
      assert.deepEqual(calls, [{ threadId: "child", processId: "9" }]);
    }),
  );

  it.effect("an in-progress turn/completed status is not terminal proof", () =>
    Effect.sync(() => {
      const ownership = makeManagedCommandOwnership();
      ownership.observe("turn/completed", {
        threadId: "root",
        turn: { id: "turn", status: "inProgress" },
      });
      assert.isFalse(ownership.completed("root", "turn"));
    }),
  );

  for (const childEnds of ["before-cleanup", "during-cleanup"] as const) {
    it.effect(`a child assigned after the interrupt snapshot is reconciled: ${childEnds}`, () =>
      Effect.gen(function* () {
        const ownership = makeManagedCommandOwnership();
        ownership.observe("turn/started", { threadId: "root", turn: { id: "turn" } });
        // The interrupt snapshots targets before the late assignment arrives.
        const snapshot = ownership.targets("root", "turn");
        assert.isFalse(snapshot.has("late-child"));
        spawnChild(ownership, "late-child", "root", "turn");
        ownership.observe("item/started", item("late-command", "late-child", "late-child-turn"));
        ownership.observe("turn/completed", {
          threadId: "root",
          turn: { id: "turn", status: "interrupted" },
        });
        const completeChild = () =>
          ownership.observe("turn/completed", {
            threadId: "late-child",
            turn: { id: "late-child-turn", status: "completed" },
          });
        if (childEnds === "before-cleanup") completeChild();
        let present = true;
        const calls: Array<{ method: string; params: unknown }> = [];
        const client = {
          request: (method: string, params?: unknown) =>
            Effect.sync(() => {
              calls.push({ method, params });
              if (method === "turn/interrupt") {
                completeChild();
                return {};
              }
              if (method.endsWith("/list"))
                return {
                  data:
                    (params as { threadId: string }).threadId === "late-child" && present
                      ? [{ itemId: "late-command", processId: "11" }]
                      : [],
                };
              present = false;
              return { terminated: true };
            }),
        };
        const result = yield* ownership.cleanup(client, snapshot, "root");
        assert.isTrue(result.confirmed, result.reason);
        assert.deepEqual(
          calls.filter((c) => c.method.endsWith("/terminate")).map((c) => c.params),
          [{ threadId: "late-child", processId: "11" }],
        );
        assert.equal(
          calls.some((c) => c.method === "turn/interrupt"),
          childEnds === "during-cleanup",
        );
      }),
    );
  }

  it.effect("bounds an unresponsive provider without claiming termination", () =>
    Effect.gen(function* () {
      const ownership = makeManagedCommandOwnership();
      ownership.observe("turn/completed", {
        threadId: "root",
        turn: { id: "turn", status: "interrupted" },
      });
      const pending = yield* ownership
        .cleanup({ request: () => Effect.never }, ownership.targets("root", "turn"), "root")
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("15 seconds");
      assert.isFalse((yield* Fiber.join(pending)).confirmed);
    }),
  );

  it.effect("refuses new child work discovered during reconciliation", () =>
    Effect.gen(function* () {
      const ownership = makeManagedCommandOwnership();
      ownership.observe("turn/completed", {
        threadId: "root",
        turn: { id: "turn", status: "interrupted" },
      });
      const result = yield* ownership.cleanup(
        {
          request: () =>
            Effect.sync(() => {
              ownership.observe("turn/started", {
                threadId: "unregistered-child",
                turn: { id: "new-turn" },
              });
              return { data: [] };
            }),
        },
        ownership.targets("root", "turn"),
        "root",
      );
      assert.isFalse(result.confirmed);
    }),
  );
  it.effect("terminates only this turn, reconciles late registration, and safely repeats", () =>
    Effect.gen(function* () {
      const ownership = makeManagedCommandOwnership();
      ownership.observe("turn/completed", {
        threadId: "root",
        turn: { id: "turn", status: "interrupted" },
      });
      ownership.observe("item/started", item("owned"));
      ownership.observe("item/started", item("service", "root", "previous"));
      let lists = 0;
      let present = true;
      const terminated: unknown[] = [];
      const client = {
        request: (method: string, params?: unknown) =>
          Effect.sync(() => {
            if (method.endsWith("/list"))
              return {
                data: [
                  { itemId: "service", processId: "2" },
                  ...(++lists > 1 && present ? [{ itemId: "owned", processId: "1" }] : []),
                ],
              };
            terminated.push(params);
            present = false;
            return { terminated: true };
          }),
      };
      const targets = ownership.targets("root", "turn");
      assert.isTrue((yield* ownership.cleanup(client, targets, "root")).confirmed);
      assert.deepEqual(terminated, [{ threadId: "root", processId: "1" }]);
      // Replay after a real exit notification must not issue another termination.
      ownership.observe("item/completed", {
        ...item("owned"),
        item: { type: "commandExecution", id: "owned", exitCode: 130 },
      });
      assert.isTrue((yield* ownership.cleanup(client, targets, "root")).confirmed);
      assert.lengthOf(terminated, 1);
    }),
  );

  it.effect("requires native child parent lineage before selecting its commands", () =>
    Effect.gen(function* () {
      const ownership = makeManagedCommandOwnership();
      ownership.observe("turn/completed", {
        threadId: "root",
        turn: { id: "turn", status: "interrupted" },
      });
      ownership.observe("turn/started", { threadId: "child", turn: { id: "child-turn" } });
      ownership.observe("item/started", item("child-command", "child", "child-turn"));
      assert.isFalse(ownership.verified("root"));
      assert.deepEqual([...ownership.targets("root", "turn")], [["root", "turn"]]);
      ownership.observe("thread/started", {
        thread: {
          id: "child",
          source: { subAgent: { thread_spawn: { parent_thread_id: "root" } } },
        },
      });
      ownership.observe("item/completed", {
        threadId: "root",
        turnId: "turn",
        item: {
          id: "spawn-child",
          type: "subAgentActivity",
          kind: "started",
          agentThreadId: "child",
        },
      });
      assert.isTrue(ownership.verified("root"));
      const targets = ownership.targets("root", "turn");
      assert.equal(targets.get("child"), "child-turn");
      ownership.observe("turn/completed", {
        threadId: "child",
        turn: { id: "child-turn", status: "interrupted" },
      });
      let present = true;
      const terminated: unknown[] = [];
      const client = {
        request: (method: string, params?: unknown) =>
          Effect.sync(() => {
            if (method.endsWith("/list"))
              return {
                data:
                  present && (params as { threadId: string }).threadId === "child"
                    ? [{ itemId: "child-command", processId: "7" }]
                    : [],
              };
            terminated.push(params);
            present = false;
            return { terminated: true };
          }),
      };
      assert.isTrue((yield* ownership.cleanup(client, targets, "root")).confirmed);
      assert.deepEqual(terminated, [{ threadId: "child", processId: "7" }]);
    }),
  );

  for (const scenario of [
    "unknown-owner",
    "missing-process",
    "false-ack",
    "cursor-cycle",
    "malformed",
  ] as const) {
    it.effect(`fails closed for ${scenario}`, () =>
      Effect.gen(function* () {
        const ownership = makeManagedCommandOwnership();
        ownership.observe("turn/completed", {
          threadId: "root",
          turn: { id: "turn", status: "interrupted" },
        });
        ownership.observe("item/started", item("owned"));
        let mutations = 0;
        const client = {
          request: (method: string) =>
            Effect.sync(() => {
              if (method.endsWith("/terminate")) {
                mutations++;
                return { terminated: false };
              }
              if (scenario === "malformed") return { data: "invalid" };
              if (scenario === "missing-process") return { data: [] };
              return {
                data: [
                  { itemId: scenario === "unknown-owner" ? "unknown" : "owned", processId: "1" },
                ],
                ...(scenario === "cursor-cycle" ? { nextCursor: "repeat" } : {}),
              };
            }),
        };
        assert.isFalse(
          (yield* ownership.cleanup(client, ownership.targets("root", "turn"), "root")).confirmed,
        );
        assert.equal(mutations, scenario === "false-ack" ? 1 : 0);
      }),
    );
  }
});
