// Minimal codex app-server stand-in for runtime-level collab tests.
// Speaks just enough of the protocol for CodexSessionRuntime to start a
// session, using REAL captured responses (codexMultiAgentWire.json), then
// replays a scripted multi-agent notification sequence read from the
// T3_CODEX_COLLAB_SCRIPT env var (a JSON file path) when the first turn
// starts. Runs as a plain Node process — stdlib only.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  NodeFS.readFileSync(NodePath.join(here, "codexMultiAgentWire.json"), "utf8"),
);
const script = JSON.parse(NodeFS.readFileSync(process.env.T3_CODEX_COLLAB_SCRIPT, "utf8"));

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let turnStartCount = 0;
let activeTurn;
const terminals = new Map();
let terminalListCount = 0;
let reloadCount = 0;
let pendingReload;
let pendingTurnStart;
let interruptCount = 0;
let approvalEndedTurn = false;
const lateCommandNotifications = [];
process.on("exit", () => {
  for (const terminal of terminals.values()) terminal.child.kill("SIGTERM");
});
process.on("SIGTERM", () => process.exit(0));
// Server->client requests the runtime must answer (approval prompts), keyed
// by the numeric JSON-RPC id this peer allocated for them.
const openServerRequests = new Map();
const rl = NodeReadline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method } = message;
  if (method === "config/mcpServer/reload" && script.deferSecondReload) {
    if (++reloadCount === 2) {
      pendingReload = id;
      write({
        method: "serverRequest/resolved",
        params: { threadId: script.rootThreadId, requestId: "fixture-reload-blocked" },
      });
    } else write({ id, result: {} });
    return;
  }
  if (method === "feedback/upload" && pendingTurnStart !== undefined) {
    // Releases a held turn/start response after the test has interrupted.
    const held = pendingTurnStart;
    pendingTurnStart = undefined;
    write({ id, result: { threadId: script.rootThreadId } });
    write({ id: held.id, result: { ...fixture.responses.turnStart, turn: held.turn } });
    return;
  }
  if (method === "feedback/upload" && pendingReload !== undefined) {
    write({ id: pendingReload, result: {} });
    pendingReload = undefined;
    write({ id, result: { threadId: script.rootThreadId } });
    return;
  }
  if (method === "thread/loaded/list") {
    if (script.loadedListError) {
      write({ id, error: { code: -32000, message: "scripted loaded-list failure" } });
      return;
    }
    write({
      id,
      result: { data: script.loadedThreads ?? [script.rootThreadId], nextCursor: null },
    });
    return;
  }
  if (method === "thread/backgroundTerminals/list") {
    terminalListCount++;
    if (script.managedCleanupError || (script.failFirstCleanupOnly && interruptCount <= 1)) {
      write({ id, error: { code: -32000, message: "scripted cleanup failure" } });
      return;
    }
    write({
      id,
      result: {
        data: [
          // Terminals a restarted provider still reports without item history.
          ...(script.inheritedTerminals ?? []).filter(
            (t) => t.threadId === message.params.threadId,
          ),
          ...[...terminals.values()].filter(
            (t) =>
              t.threadId === message.params.threadId &&
              t.child.exitCode === null &&
              (!t.late || terminalListCount > 1),
          ),
        ].map((t) => ({ itemId: t.itemId, processId: t.processId })),
        nextCursor: null,
      },
    });
    return;
  }
  if (method === "thread/backgroundTerminals/terminate") {
    const t = terminals.get(message.params.processId);
    if (!t || t.threadId !== message.params.threadId) {
      write({ id, result: { terminated: false } });
      return;
    }
    await new Promise((resolve) => {
      t.child.once("exit", resolve);
      t.child.kill("SIGTERM");
    });
    terminals.delete(t.processId);
    write({ id, result: { terminated: true } });
    return;
  }
  if (openServerRequests.has(id)) {
    // The runtime answered an approval request. Record the response so tests
    // can assert settlement behavior, then emit serverRequest/resolved as a
    // deterministic receipt (tests wait on the runtime's event stream rather
    // than polling the sidecar file). Real codex identifies the resolved
    // request by its item id — the key the runtime correlates on — so the
    // receipt exercises the same path that closes the approval card in the
    // UI.
    const request = openServerRequests.get(id);
    openServerRequests.delete(id);
    NodeFS.appendFileSync(
      `${process.env.T3_CODEX_COLLAB_SCRIPT}.approvalResponses`,
      `${JSON.stringify({ id, label: request.label, result: message.result ?? null })}\n`,
    );
    write({
      jsonrpc: "2.0",
      method: "serverRequest/resolved",
      params: {
        threadId: script.rootThreadId,
        requestId: request.itemId ?? request.label,
      },
    });
    if (script.cancelApprovalEndsTurn && message.result?.decision === "cancel") {
      write({
        method: "item/completed",
        params: {
          threadId: script.rootThreadId,
          turnId: activeTurn.id,
          completedAtMs: 2,
          item: {
            id: request.itemId,
            type: "commandExecution",
            command: "pending fixture",
            cwd: "/tmp",
            status: "declined",
            commandActions: [],
            exitCode: null,
            processId: null,
          },
        },
      });
      write({
        method: "turn/completed",
        params: { threadId: script.rootThreadId, turn: { ...activeTurn, status: "interrupted" } },
      });
      approvalEndedTurn = true;
    }
    return;
  }
  if (method === undefined && script.serverRequests?.some((request) => request.id === id)) {
    NodeFS.appendFileSync(
      `${process.env.T3_CODEX_COLLAB_SCRIPT}.responses`,
      `${JSON.stringify({ id, result: message.result, error: message.error })}\n`,
    );
    if (script.completeTurnOnServerResponse && activeTurn) {
      write({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: script.rootThreadId,
          turn: { ...activeTurn, status: "completed" },
        },
      });
    }
    return;
  }
  if (method === "initialize") {
    write({
      id,
      result: {
        userAgent: "t3-collab-mock/0.0.0",
        codexHome: "/tmp",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    return;
  }
  if (method === "account/read") {
    write({ id, result: { account: { type: "apiKey" }, requiresOpenaiAuth: false } });
    return;
  }
  if (method === "skills/list" || method === "model/list") {
    write({ id, result: { data: [] } });
    return;
  }
  if (method === "thread/start") {
    write({ id, result: fixture.responses.threadStart });
    return;
  }
  if (method === "thread/resume") {
    if (script.recordRequests) {
      NodeFS.appendFileSync(
        `${process.env.T3_CODEX_COLLAB_SCRIPT}.requests`,
        `${JSON.stringify({ method, params: message.params })}\n`,
      );
    }
    const threadId = message.params?.threadId;
    const childSnapshot = script.childResumeSnapshots?.[threadId];
    if (script.resumeRequestMarker) {
      write({
        jsonrpc: "2.0",
        method: "serverRequest/resolved",
        params: {
          threadId: script.rootThreadId,
          requestId: script.resumeRequestMarker,
        },
      });
    }
    if (childSnapshot?.hang) {
      return;
    }
    if (childSnapshot?.error) {
      write({ id, error: { code: -32000, message: childSnapshot.error } });
      return;
    }
    if (childSnapshot) {
      write({
        id,
        result: {
          ...fixture.responses.threadStart,
          model: childSnapshot.model,
          reasoningEffort: childSnapshot.reasoningEffort,
          thread: {
            ...fixture.responses.threadStart.thread,
            id: threadId,
            sessionId: threadId,
          },
        },
      });
      for (const notification of childSnapshot.notifications ?? []) {
        write({ jsonrpc: "2.0", method: notification.method, params: notification.params });
      }
      return;
    }
    write({ id, result: fixture.responses.threadStart });
    return;
  }
  if (method === "turn/start") {
    approvalEndedTurn = false;
    if (script.deferSecondReload)
      NodeFS.appendFileSync(`${process.env.T3_CODEX_COLLAB_SCRIPT}.turnStarts`, "start\n");
    const turnId = script.turnIds?.[turnStartCount];
    const turn = turnId
      ? { ...fixture.responses.turnStart.turn, id: turnId }
      : fixture.responses.turnStart.turn;
    turnStartCount += 1;
    if (script.holdSecondTurnStart && turnStartCount === 2) {
      // The response stays in flight until the test releases it (feedback/upload).
      pendingTurnStart = { id, turn };
      write({
        method: "serverRequest/resolved",
        params: { threadId: script.rootThreadId, requestId: "fixture-turn-start-held" },
      });
      return;
    }
    activeTurn = turn;
    write({ id, result: { ...fixture.responses.turnStart, turn } });
    const rootThreadId = script.rootThreadId;
    if (script.onlyFirstTurnStarts !== true || turnStartCount === 1) {
      write({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { threadId: rootThreadId, turn },
      });
    }
    if (turnStartCount === 1 && script.managedTerminals) {
      for (const [index, spec] of script.managedTerminals.entries()) {
        const child = NodeChildProcess.spawn(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000)"],
          {
            stdio: "ignore",
          },
        );
        await new Promise((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
        const processId = String(index + 1);
        const threadId = spec.threadId ?? rootThreadId;
        const itemId = `command-${processId}`;
        terminals.set(processId, { child, threadId, itemId, processId, late: spec.late });
        NodeFS.appendFileSync(
          `${process.env.T3_CODEX_COLLAB_SCRIPT}.processes`,
          `${JSON.stringify({ pid: child.pid, kind: spec.kind, processId })}\n`,
        );
        if (spec.kind !== "sibling") {
          const notification = {
            method: "item/started",
            params: {
              startedAtMs: 1,
              threadId,
              turnId: spec.kind === "retained" ? "earlier-turn" : turn.id,
              item: {
                id: itemId,
                type: "commandExecution",
                command: "node fixture",
                cwd: "/tmp",
                status: "inProgress",
                commandActions: [],
                processId,
              },
            },
          };
          if (script.missingTerminal && spec.kind === "owned")
            lateCommandNotifications.push(notification);
          else write(notification);
        }
      }
      write({
        method: "serverRequest/resolved",
        params: { threadId: rootThreadId, requestId: "fixture-processes-ready" },
      });
    }
    for (const notification of script.notifications) {
      write({ jsonrpc: "2.0", method: notification.method, params: notification.params });
    }
    for (const [index, request] of (script.serverRequests ?? []).entries()) {
      if (request.id !== undefined) {
        // Legacy form: caller-supplied JSON-RPC ids recorded in .responses.
        write({ jsonrpc: "2.0", id: request.id, method: request.method, params: request.params });
        continue;
      }
      // Scripted server->client requests (approval prompts). String values in
      // params may reference "${threadId}" / "${turnId}" placeholders that are
      // substituted with the ids this peer actually allocated.
      const requestId = 9000 + index;
      const label = request.label ?? `approval-${requestId}`;
      openServerRequests.set(requestId, { label, itemId: request.params?.itemId });
      const params = JSON.parse(
        JSON.stringify(request.params)
          .replaceAll("${threadId}", String(rootThreadId))
          .replaceAll("${turnId}", String(turn.id)),
      );
      if (script.cancelApprovalEndsTurn)
        write({
          method: "item/started",
          params: {
            threadId: script.rootThreadId,
            turnId: turn.id,
            startedAtMs: 1,
            item: {
              id: params.itemId,
              type: "commandExecution",
              command: "pending fixture",
              cwd: "/tmp",
              status: "inProgress",
              commandActions: [],
              processId: null,
            },
          },
        });
      write({ jsonrpc: "2.0", id: requestId, method: request.method, params });
    }
    if (script.holdTurnOpen !== true) {
      write({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: rootThreadId,
          turn: { ...turn, status: "completed" },
        },
      });
    }
    return;
  }
  if (method === "turn/interrupt") {
    interruptCount++;
    // Record which thread/turn was interrupted (append-only sidecar file the
    // test reads) so Stop coverage can assert every live child was reached.
    // failInterruptFor simulates a dead child whose interrupt errors.
    const target = message.params?.threadId;
    NodeFS.appendFileSync(
      `${process.env.T3_CODEX_COLLAB_SCRIPT}.interrupts`,
      `${JSON.stringify({ threadId: target, turnId: message.params?.turnId })}\n`,
    );
    if (approvalEndedTurn) {
      NodeFS.writeFileSync(
        `${process.env.T3_CODEX_COLLAB_SCRIPT}.noActiveInterrupt`,
        "confirmed\n",
      );
      write({ id, error: { code: -32600, message: "no active turn to interrupt" } });
      return;
    }
    if (
      script.expectedActiveTurnId &&
      message.params?.threadId === script.rootThreadId &&
      message.params?.turnId !== script.expectedActiveTurnId
    ) {
      write({
        id,
        error: {
          code: -32000,
          message: `expected active turn id ${message.params?.turnId} but found ${script.expectedActiveTurnId}`,
        },
      });
      return;
    }
    if (script.failInterruptFor && script.failInterruptFor === target) {
      write({ id, error: { code: -32000, message: "thread already closed" } });
      return;
    }
    if (script.hangInterruptFor && script.hangInterruptFor === target) {
      // Never respond: simulates a wedged child whose RPC neither resolves
      // nor rejects. The runtime's bounded deadline must move on.
      return;
    }
    if (script.managedTerminals && !script.missingTerminal && target === script.rootThreadId)
      write({
        method: "turn/completed",
        params: { threadId: target, turn: { ...activeTurn, status: "interrupted" } },
      });
    write({ id, result: {} });
    for (const notification of lateCommandNotifications.splice(0)) write(notification);
    return;
  }
  if (id !== undefined) {
    write({ id, result: {} });
  }
});
