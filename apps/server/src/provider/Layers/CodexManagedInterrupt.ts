import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CodexAppServerClient } from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";

// These experimental shapes are verified against the pinned Codex 0.157.1 binary.
const TerminalPage = Schema.Struct({
  data: Schema.Array(Schema.Struct({ itemId: Schema.String, processId: Schema.String })),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const Termination = Schema.Struct({ terminated: Schema.Boolean });
const Notification = Schema.Struct({
  threadId: Schema.optionalKey(Schema.String),
  turnId: Schema.optionalKey(Schema.String),
  turn: Schema.optionalKey(
    Schema.Struct({ id: Schema.String, status: Schema.optionalKey(Schema.String) }),
  ),
  thread: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String,
      source: Schema.optionalKey(Schema.Unknown),
    }),
  ),
  item: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String,
      type: Schema.String,
      kind: Schema.optionalKey(Schema.String),
      status: Schema.optionalKey(Schema.String),
      agentThreadId: Schema.optionalKey(Schema.String),
      exitCode: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
      processId: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
});
const SpawnSource = Schema.Struct({
  subAgent: Schema.Struct({ thread_spawn: Schema.Struct({ parent_thread_id: Schema.String }) }),
});

const decodeNotification = Schema.decodeUnknownOption(Notification);
const decodeSpawnSource = Schema.decodeUnknownOption(SpawnSource);
const decodeTerminalPage = Schema.decodeUnknownEffect(TerminalPage);
const decodeTermination = Schema.decodeUnknownEffect(Termination);

type Command = {
  threadId: string;
  turnId: string;
  itemId: string;
  processId: string | undefined;
  exited: boolean;
};
type Client = Pick<CodexAppServerClient["Service"]["raw"], "request">;
export type ManagedInterruptResult = { confirmed: boolean; reason: string; terminated: number };

const LoadedPage = Schema.Struct({
  data: Schema.Array(Schema.String),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodeLoadedPage = Schema.decodeUnknownEffect(LoadedPage);

/**
 * Background terminals belong to each thread's own session (Codex 0.157.1
 * builds a UnifiedExecProcessManager per session), so every thread loaded in
 * this app-server is listed, not only the root. Any listing failure fails.
 */
const listLoadedThreads = (client: Client) =>
  Effect.gen(function* () {
    let cursor: string | null = null;
    const seen = new Set<string>();
    const threads = new Set<string>();
    do {
      const page: typeof LoadedPage.Type = yield* client
        .request("thread/loaded/list", { cursor, limit: 100 })
        .pipe(Effect.flatMap(decodeLoadedPage));
      for (const thread of page.data) threads.add(thread);
      cursor = page.nextCursor ?? null;
      if (threads.size > 256 || (cursor !== null && (seen.has(cursor) || seen.size >= 64)))
        return yield* CodexErrors.CodexAppServerRequestError.internalError(
          "Loaded thread pagination is incomplete.",
        );
      if (cursor !== null) seen.add(cursor);
    } while (cursor !== null);
    return [...threads];
  });

export const listLoadedThreadTerminals = (client: Client) =>
  Effect.gen(function* () {
    const threads = yield* listLoadedThreads(client);
    let total = 0;
    for (const thread of threads) total += (yield* listBackgroundTerminals(client, thread)).length;
    return { threads: threads.length, terminals: total };
  });

/**
 * Stop-time cleanup for a managed session being closed or replaced in-process:
 * every background terminal on every loaded thread is terminated, each with the
 * provider's confirmation, and a final listing must be empty. The next
 * app-server cannot see terminals this one leaves, so anything short of that
 * proof is reported as unconfirmed (false).
 */
export const terminateLoadedThreadTerminals = (client: Client) =>
  Effect.gen(function* () {
    for (let pass = 0; pass < 4; pass++) {
      let found = 0;
      for (const thread of yield* listLoadedThreads(client)) {
        for (const terminal of yield* listBackgroundTerminals(client, thread)) {
          found++;
          const response = yield* client
            .request("thread/backgroundTerminals/terminate", {
              threadId: thread,
              processId: terminal.processId,
            })
            .pipe(Effect.flatMap(decodeTermination));
          if (!response.terminated) return false;
        }
      }
      if (found === 0) return true;
      yield* Effect.yieldNow;
    }
    return false;
  }).pipe(
    Effect.timeout("15 seconds"),
    Effect.catchCause(() => Effect.succeed(false)),
  );

/** Every background terminal the provider reports for one thread, all pages. */
export const listBackgroundTerminals = (client: Client, threadId: string) =>
  Effect.gen(function* () {
    let cursor: string | null = null;
    const seen = new Set<string>();
    const all: Array<(typeof TerminalPage.Type.data)[number]> = [];
    do {
      const page: typeof TerminalPage.Type = yield* client
        .request("thread/backgroundTerminals/list", { threadId, cursor, limit: 100 })
        .pipe(Effect.flatMap(decodeTerminalPage));
      all.push(...page.data);
      cursor = page.nextCursor ?? null;
      if (all.length > 4096 || (cursor !== null && (seen.has(cursor) || seen.size >= 64)))
        return yield* CodexErrors.CodexAppServerRequestError.internalError(
          "Terminal pagination is incomplete.",
        );
      if (cursor !== null) seen.add(cursor);
    } while (cursor !== null);
    return all;
  });

/** Provider identities only. Never derives authority from command text, cwd, or OS process names. */
export function makeManagedCommandOwnership() {
  const commands = new Map<string, Command>();
  const parents = new Map<string, string>();
  const liveTurns = new Map<string, string>();
  const spawns = new Map<string, { parent: string; turn: string }>();
  const completions = new Set<string>();
  // A spawned child is pending until it starts a turn or its thread closes.
  const startedThreads = new Set<string>();
  const closedThreads = new Set<string>();
  const listeners = new Set<() => void>();
  let incomplete = false;
  const key = (threadId: string, itemId: string) => JSON.stringify([threadId, itemId]);
  const isAncestor = (candidate: string, thread: string) => {
    const seen = new Set<string>();
    for (let spawn = spawns.get(thread); spawn && !seen.has(thread); spawn = spawns.get(thread)) {
      if (parents.get(thread) !== spawn.parent) return false;
      if (spawn.parent === candidate) return true;
      seen.add(thread);
      thread = spawn.parent;
    }
    return false;
  };
  const observe = (method: string, value: unknown) => {
    const decoded = decodeNotification(value);
    if (decoded._tag === "None") return;
    const p = decoded.value;
    if (method === "thread/started" && p.thread) {
      const source = decodeSpawnSource(p.thread.source);
      if (source._tag === "Some") {
        const parent = source.value.subAgent.thread_spawn.parent_thread_id;
        if (
          (parents.has(p.thread.id) && parents.get(p.thread.id) !== parent) ||
          parents.size >= 256
        )
          incomplete = true;
        else parents.set(p.thread.id, parent);
      }
    }
    if (method === "thread/closed" && p.threadId) {
      if (!closedThreads.has(p.threadId) && closedThreads.size >= 256) incomplete = true;
      else closedThreads.add(p.threadId);
    }
    if (method === "turn/started" && p.threadId && p.turn) {
      if (!startedThreads.has(p.threadId) && startedThreads.size >= 256) incomplete = true;
      else startedThreads.add(p.threadId);
      if (!liveTurns.has(p.threadId) && liveTurns.size >= 256) incomplete = true;
      else liveTurns.set(p.threadId, p.turn.id);
    }
    if (method === "turn/completed" && p.threadId && p.turn) {
      if (liveTurns.get(p.threadId) === p.turn.id) liveTurns.delete(p.threadId);
      // Every terminal status is a receipt: a failed child turn can still leave
      // background commands behind, and its cleanup must not wait forever.
      if (p.turn.status !== undefined && p.turn.status !== "inProgress") {
        if (completions.size >= 4096) incomplete = true;
        else completions.add(key(p.threadId, p.turn.id));
      }
    }
    if (
      (method === "item/started" || method === "item/completed") &&
      p.threadId &&
      p.turnId &&
      p.item?.type === "subAgentActivity" &&
      p.item.kind === "started" &&
      p.item.agentThreadId
    ) {
      const previous = spawns.get(p.item.agentThreadId);
      if (
        (previous && (previous.parent !== p.threadId || previous.turn !== p.turnId)) ||
        spawns.size >= 256
      )
        incomplete = true;
      else spawns.set(p.item.agentThreadId, { parent: p.threadId, turn: p.turnId });
    }
    if (
      (method === "item/started" || method === "item/completed") &&
      p.threadId &&
      p.turnId &&
      p.item?.type === "subAgentActivity" &&
      p.item.kind === "interacted" &&
      p.item.agentThreadId
    ) {
      // Only an interaction toward a spawned descendant can hand it new work.
      // A child reporting to its parent or root (captured with Codex 0.157.1)
      // transfers no ownership. Any other target stays fail-closed.
      if (!isAncestor(p.item.agentThreadId, p.threadId)) {
        const spawn = spawns.get(p.item.agentThreadId);
        if (!spawn || spawn.parent !== p.threadId || spawn.turn !== p.turnId) incomplete = true;
      }
    }
    if (
      (method === "item/started" || method === "item/completed") &&
      p.threadId &&
      p.turnId &&
      p.item?.type === "commandExecution"
    ) {
      const id = key(p.threadId, p.item.id);
      const prior = commands.get(id);
      if (prior && prior.turnId !== p.turnId) {
        incomplete = true;
        return;
      }
      if (prior?.processId && p.item.processId && prior.processId !== p.item.processId) {
        incomplete = true;
        return;
      }
      if (!prior && commands.size >= 4096) {
        incomplete = true;
        return;
      }
      commands.set(id, {
        threadId: p.threadId,
        turnId: p.turnId,
        itemId: p.item.id,
        processId: p.item.processId ?? prior?.processId,
        exited:
          prior?.exited === true ||
          (method === "item/completed" && typeof p.item.exitCode === "number") ||
          (method === "item/completed" &&
            p.item.status === "declined" &&
            p.item.processId == null &&
            prior?.processId === undefined),
      });
    }
    if (parents.size > 256 || liveTurns.size > 256) incomplete = true;
    // Waiters re-check after every observation: completions, turn starts and
    // thread closures can each settle a pending cleanup condition. They resume
    // through a yield, so the caller's notification handling (and any items it
    // delivers next) completes before cleanup continues.
    for (const notify of listeners) notify();
  };
  // A lineage proves which thread is the parent; the parent's started activity
  // independently proves which parent turn created this assignment.
  const rootTurn = (thread: string, root: string): string | undefined => {
    const seen = new Set<string>();
    while (thread !== root) {
      if (seen.has(thread)) return undefined;
      seen.add(thread);
      const spawn = spawns.get(thread);
      if (!spawn || parents.get(thread) !== spawn.parent) return undefined;
      if (spawn.parent === root) return spawn.turn;
      thread = spawn.parent;
    }
    return undefined;
  };
  const targets = (root: string, turn: string) => {
    const turns = new Map([[root, turn]]);
    for (const command of commands.values()) {
      if (command.threadId !== root && !command.exited && rootTurn(command.threadId, root) === turn)
        turns.set(command.threadId, command.turnId);
    }
    for (const [threadId, turnId] of liveTurns) {
      if (threadId !== root && rootTurn(threadId, root) === turn) turns.set(threadId, turnId);
    }
    return turns;
  };
  // Assigned children under this root turn that have neither started a turn nor
  // closed: their first turn and its commands would otherwise escape cleanup.
  const pendingChildren = (root: string, turn: string) =>
    [...spawns.keys()].filter(
      (thread) =>
        rootTurn(thread, root) === turn &&
        !startedThreads.has(thread) &&
        !closedThreads.has(thread),
    );
  const awaitNoPendingChildren = (root: string, turn: string) =>
    Effect.callback<void>((resume) => {
      const notify = () => {
        if (pendingChildren(root, turn).length === 0) resume(Effect.yieldNow);
      };
      listeners.add(notify);
      notify();
      return Effect.sync(() => {
        listeners.delete(notify);
      });
    }).pipe(Effect.timeoutOption("10 seconds"));
  const verified = (root: string) =>
    !incomplete &&
    [...liveTurns.keys()].every(
      (thread) => thread === root || rootTurn(thread, root) !== undefined,
    );
  const completed = (thread: string, turn: string) => completions.has(key(thread, turn));
  const terminalProof = (turns: Iterable<readonly [string, string]>) =>
    [...turns].every(([thread, turn]) => completed(thread, turn));
  const awaitTerminals = (turns: Iterable<readonly [string, string]>) =>
    Effect.callback<void>((resume) => {
      const notify = () => {
        if (terminalProof(turns)) resume(Effect.yieldNow);
      };
      listeners.add(notify);
      notify();
      return Effect.sync(() => {
        listeners.delete(notify);
      });
    }).pipe(Effect.timeout("10 seconds"));
  const cleanup = (client: Client, turns: ReadonlyMap<string, string>, root: string) =>
    Effect.gen(function* () {
      let terminated = 0;
      const acknowledged = new Set<string>();
      const fail = (reason: string): ManagedInterruptResult => ({
        confirmed: false,
        reason,
        terminated,
      });
      if (incomplete) return fail("Command ownership history is incomplete.");
      const rootTurnId = turns.get(root);
      if (rootTurnId === undefined) return fail("The interrupted root turn is unknown.");
      // The caller's snapshot can predate an assignment whose spawn, start and
      // command notifications arrive later. Each pass re-derives the owned set.
      // Keyed by (thread, turn): a known child thread can start another assigned
      // turn during cleanup, and that new pair is late work in its own right.
      const pairKey = (thread: string, turn: string) => JSON.stringify([thread, turn]);
      const snapshotPairs = new Set([...turns].map(([thread, turn]) => pairKey(thread, turn)));
      const pairs = new Map<string, readonly [string, string]>();
      const scopeNow = () => {
        for (const [thread, turn] of [...turns, ...targets(root, rootTurnId)])
          pairs.set(pairKey(thread, turn), [thread, turn]);
        return [...pairs.values()];
      };
      let scope = scopeNow();
      const inScope = (thread: string, turn: string) => pairs.has(pairKey(thread, turn));
      const owned = (command: Command) =>
        command.threadId === root
          ? command.turnId === rootTurnId
          : rootTurn(command.threadId, root) === rootTurnId;
      const scopeStable = () =>
        verified(root) &&
        pendingChildren(root, rootTurnId).length === 0 &&
        scope.every(([thread, turn]) => completed(thread, turn)) &&
        [...liveTurns].every(([thread, turn]) =>
          thread === root
            ? turn === rootTurnId
            : rootTurn(thread, root) !== rootTurnId || inScope(thread, turn),
        ) &&
        [...commands.values()].every(
          (command) =>
            command.threadId === root ||
            command.exited ||
            rootTurn(command.threadId, root) !== undefined,
        ) &&
        [...commands.values()].every(
          (command) => !owned(command) || completed(command.threadId, command.turnId),
        );
      // A late owned child that is still running is interrupted here and must
      // produce its own terminal receipt before its terminals are reconciled.
      const settleLate = Effect.gen(function* () {
        if ((yield* awaitNoPendingChildren(root, rootTurnId))._tag === "None") return false;
        scope = scopeNow();
        const late = scope.filter(
          ([thread, turn]) => !snapshotPairs.has(pairKey(thread, turn)) && !completed(thread, turn),
        );
        yield* Effect.forEach(
          late,
          ([threadId, turnId]) =>
            client
              .request("turn/interrupt", { threadId, turnId })
              .pipe(Effect.timeout("3 seconds"), Effect.ignore),
          { concurrency: 8 },
        );
        // Only late children are awaited: a missing receipt for the caller's
        // own targets still fails closed at once through scopeStable.
        if (late.length > 0) yield* awaitTerminals(late);
        return true;
      });
      if (!(yield* settleLate))
        return fail("A spawned child neither started a turn nor closed within the bound.");
      if (!scopeStable()) return fail("Turn completion or assignment ownership is unconfirmed.");
      const list = (threadId: string) => listBackgroundTerminals(client, threadId);
      // A command can register while the interrupt is settling. Missing ownership
      // is never treated as proof of exit; bounded reconciliation fails closed.
      for (let pass = 0; pass < 4; pass++) {
        const before = scope.length;
        if (!(yield* settleLate))
          return fail("A spawned child neither started a turn nor closed within the bound.");
        if (!scopeStable())
          return fail("Execution changed while interruption was being reconciled.");
        let remaining = scope.length !== before;
        for (const threadId of new Set(scope.map(([thread]) => thread))) {
          for (const terminal of yield* list(threadId)) {
            const command = commands.get(key(threadId, terminal.itemId));
            if (!command) return fail("A terminal has no verified command-item owner.");
            if (command.processId !== undefined && command.processId !== terminal.processId)
              return fail("The provider changed a command's process identity.");
            if (!owned(command)) continue; // Retain earlier assignments and services.
            remaining = true;
            const response = yield* client
              .request("thread/backgroundTerminals/terminate", {
                threadId,
                processId: terminal.processId,
              })
              .pipe(Effect.flatMap(decodeTermination));
            if (!response.terminated)
              return fail("The provider did not confirm command termination.");
            acknowledged.add(key(threadId, terminal.itemId));
            terminated++;
          }
        }
        const unresolved = [...commands.values()].some(
          (command) =>
            owned(command) &&
            !command.exited &&
            !acknowledged.has(key(command.threadId, command.itemId)),
        );
        if (!scopeStable())
          return fail("Execution changed while interruption was being reconciled.");
        if (!remaining && !unresolved)
          return { confirmed: true, reason: "Owned commands terminated.", terminated };
        yield* Effect.yieldNow;
      }
      return fail("Owned command exit could not be confirmed within the reconciliation bound.");
    }).pipe(
      Effect.timeout("15 seconds"),
      Effect.catchCause(() =>
        Effect.succeed<ManagedInterruptResult>({
          confirmed: false,
          reason: "Command cleanup failed or timed out; termination is unconfirmed.",
          terminated: 0,
        }),
      ),
    );
  return { observe, targets, cleanup, verified, completed, awaitTerminals };
}
