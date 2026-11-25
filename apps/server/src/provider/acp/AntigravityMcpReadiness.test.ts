// @effect-diagnostics nodeBuiltinImport:off -- utimes controls mtime fixtures deterministically.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import {
  resolveExpectedAntigravityExternalMcpServers,
  snapshotAntigravityMcpCache,
  waitForAntigravityExternalMcpReadiness,
} from "./AntigravityMcpReadiness.ts";

it.layer(NodeServices.layer)("AntigravityMcpReadiness", (it) => {
  it.effect("returns empty with zero overhead when no external MCP servers are configured", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-mcp-empty-" });
      const profileDirectory = path.join(root, "profile");
      const cwd = path.join(root, "workspace");
      yield* fs.makeDirectory(profileDirectory, { recursive: true });
      yield* fs.makeDirectory(cwd, { recursive: true });

      const snapshot = yield* snapshotAntigravityMcpCache({ profileDirectory, cwd });
      expect(snapshot.expectedServers).toEqual([]);

      const phases: Array<string | undefined> = [];
      const result = yield* waitForAntigravityExternalMcpReadiness({
        profileDirectory,
        snapshot,
        reportStartupPhase: (phase) => Effect.sync(() => phases.push(phase)),
      });
      expect(result).toEqual({ ready: [], failed: [], timedOut: [] });
      expect(phases).toEqual([]);
    }),
  );

  it.effect(
    "resolves expected servers across profile mcp_config, enabled plugins, and workspace plugins",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-mcp-resolve-" });
        const profileDirectory = path.join(root, "profile");
        const cwd = path.join(root, "workspace");

        yield* fs.makeDirectory(path.join(profileDirectory, "config", "plugins", "notion"), {
          recursive: true,
        });
        yield* fs.makeDirectory(path.join(profileDirectory, "config", "plugins", "muted"), {
          recursive: true,
        });
        yield* fs.makeDirectory(path.join(cwd, ".agents", "plugins", "repo-tools"), {
          recursive: true,
        });

        yield* fs.writeFileString(
          path.join(profileDirectory, "config", "mcp_config.json"),
          JSON.stringify({
            mcpServers: {
              "t3-code": { url: "http://127.0.0.1/mcp" },
              custom: { command: "custom-mcp" },
              off: { command: "off-mcp", disabled: true },
            },
          }),
        );
        yield* fs.writeFileString(
          path.join(profileDirectory, "config", "config.json"),
          JSON.stringify({
            plugins: {
              notion: { enabled: true },
              muted: { enabled: false },
            },
          }),
        );
        yield* fs.writeFileString(
          path.join(profileDirectory, "config", "plugins", "notion", "plugin.json"),
          JSON.stringify({ name: "notion", disabled: true }),
        );
        yield* fs.writeFileString(
          path.join(profileDirectory, "config", "plugins", "notion", "mcp_config.json"),
          JSON.stringify({ mcpServers: { notion: { url: "https://mcp.notion.com/mcp" } } }),
        );
        yield* fs.writeFileString(
          path.join(profileDirectory, "config", "plugins", "muted", "mcp_config.json"),
          JSON.stringify({ mcpServers: { hidden: { command: "hidden" } } }),
        );
        yield* fs.writeFileString(
          path.join(cwd, ".agents", "plugins", "repo-tools", "mcp_config.json"),
          JSON.stringify({ mcpServers: { lint: { command: "lint-mcp" } } }),
        );

        const expected = yield* resolveExpectedAntigravityExternalMcpServers({
          profileDirectory,
          cwd,
        });
        expect(expected).toEqual(["custom", "notion_notion", "repo-tools_lint"]);
      }),
  );

  it.effect(
    "waits for repeat-connect mtime advancement + quiescence and short-circuits on connector.go failure lines (agy 1.5.x fixture)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-mcp-ready-" });
        const profileDirectory = path.join(root, "profile");
        const cwd = path.join(root, "workspace");
        const acpDir = path.join(profileDirectory, "antigravity-acp");
        const notionCacheDir = path.join(acpDir, "mcp", "notion_notion");
        const logDir = path.join(acpDir, "log");

        yield* fs.makeDirectory(path.join(profileDirectory, "config", "plugins", "notion"), {
          recursive: true,
        });
        yield* fs.makeDirectory(
          path.join(profileDirectory, "config", "plugins", "structural-biology"),
          { recursive: true },
        );
        yield* fs.makeDirectory(notionCacheDir, { recursive: true });
        yield* fs.makeDirectory(logDir, { recursive: true });
        yield* fs.makeDirectory(cwd, { recursive: true });

        yield* fs.writeFileString(
          path.join(profileDirectory, "config", "plugins", "notion", "mcp_config.json"),
          JSON.stringify({ mcpServers: { notion: { url: "https://mcp.notion.com/mcp" } } }),
        );
        yield* fs.writeFileString(
          path.join(profileDirectory, "config", "plugins", "structural-biology", "mcp_config.json"),
          JSON.stringify({ mcpServers: { structure_viewer_mcp: { command: "agy-node" } } }),
        );

        // Pre-existing cache + stale log from an earlier process must NOT satisfy readiness.
        const staleToolFile = path.join(notionCacheDir, "notion-search.json");
        yield* fs.writeFileString(staleToolFile, '{"name":"notion-search"}');
        const oldEpochSeconds = 1_700_000_000;
        yield* Effect.promise(() =>
          NodeFSP.utimes(staleToolFile, oldEpochSeconds, oldEpochSeconds),
        );
        yield* Effect.promise(() =>
          NodeFSP.utimes(notionCacheDir, oldEpochSeconds, oldEpochSeconds),
        );
        yield* fs.writeFileString(
          path.join(logDir, "acp-server-20261125_120000-11111.log"),
          "W1125 12:00:01.000000 100 connector.go:131] MCP server notion_notion: stale error\n",
        );

        const snapshot = yield* snapshotAntigravityMcpCache({ profileDirectory, cwd });
        expect(snapshot.expectedServers).toEqual([
          "notion_notion",
          "structural-biology_structure_viewer_mcp",
        ]);

        const phases: Array<string | undefined> = [];
        const waiter = yield* waitForAntigravityExternalMcpReadiness({
          profileDirectory,
          snapshot,
          timeoutMs: 2_000,
          quiescenceMs: 80,
          pollIntervalMs: 20,
          reportStartupPhase: (phase) => Effect.sync(() => phases.push(phase)),
        }).pipe(Effect.forkChild);

        // Simulate fresh agy 1.5.17 process: Notion rewrites its cache and structural-biology fails in connector.go.
        yield* TestClock.adjust("20 millis");
        yield* fs.writeFileString(staleToolFile, '{"name":"notion-search","v":2}');
        yield* fs.writeFileString(
          path.join(logDir, "acp-server-20261125_140939-65328.log"),
          'W1125 14:09:40.594808   305 connector.go:131] MCP server structural-biology_structure_viewer_mcp: exec: "agy-node": executable file not found in $PATH\n',
        );
        // First poll records new mtime; subsequent polls advance past 80ms quiescence.
        for (let step = 0; step < 8; step++) {
          yield* TestClock.adjust("20 millis");
        }

        const result = yield* Fiber.join(waiter);
        expect(result).toEqual({
          ready: ["notion_notion"],
          failed: ["structural-biology_structure_viewer_mcp"],
          timedOut: [],
        });
        expect(phases).toEqual(["mcp", undefined]);
      }),
  );

  it.effect(
    "bounds readiness wait non-fatally with a warning and clears startupPhase on timeout",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-mcp-timeout-" });
        const profileDirectory = path.join(root, "profile");
        const cwd = path.join(root, "workspace");
        yield* fs.makeDirectory(path.join(profileDirectory, "config"), { recursive: true });
        yield* fs.makeDirectory(cwd, { recursive: true });
        yield* fs.writeFileString(
          path.join(profileDirectory, "config", "mcp_config.json"),
          JSON.stringify({ mcpServers: { slow_mcp: { command: "slow" } } }),
        );

        const snapshot = yield* snapshotAntigravityMcpCache({ profileDirectory, cwd });
        const phases: Array<string | undefined> = [];
        const warnings: Array<string> = [];
        const captureLogger = Logger.make((options) => {
          warnings.push(String(options.message));
        });

        const waiter = yield* waitForAntigravityExternalMcpReadiness({
          profileDirectory,
          snapshot,
          timeoutMs: 60,
          quiescenceMs: 20,
          pollIntervalMs: 15,
          reportStartupPhase: (phase) => Effect.sync(() => phases.push(phase)),
        }).pipe(Effect.provide(Logger.layer([captureLogger])), Effect.forkChild);

        for (let step = 0; step < 6; step++) {
          yield* TestClock.adjust("15 millis");
        }
        const result = yield* Fiber.join(waiter);

        expect(result).toEqual({ ready: [], failed: [], timedOut: ["slow_mcp"] });
        expect(phases).toEqual(["mcp", undefined]);
        expect(
          warnings.some((line) => line.includes("Timed out waiting for Antigravity external MCP")),
        ).toBe(true);
      }),
  );
});

describe("AntigravityMcpReadiness interruption", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("clears startupPhase when interrupted before completion", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-mcp-interrupt-" });
        const profileDirectory = path.join(root, "profile");
        const cwd = path.join(root, "workspace");
        yield* fs.makeDirectory(path.join(profileDirectory, "config"), { recursive: true });
        yield* fs.makeDirectory(cwd, { recursive: true });
        yield* fs.writeFileString(
          path.join(profileDirectory, "config", "mcp_config.json"),
          JSON.stringify({ mcpServers: { slow_mcp: { command: "slow" } } }),
        );

        const snapshot = yield* snapshotAntigravityMcpCache({ profileDirectory, cwd });
        const phases: Array<string | undefined> = [];
        const fiber = yield* waitForAntigravityExternalMcpReadiness({
          profileDirectory,
          snapshot,
          timeoutMs: 10_000,
          pollIntervalMs: 25,
          reportStartupPhase: (phase) => Effect.sync(() => phases.push(phase)),
        }).pipe(Effect.forkChild);

        yield* TestClock.adjust("25 millis");
        yield* Fiber.interrupt(fiber);
        expect(phases).toEqual(["mcp", undefined]);
      }),
    );
  });
});
