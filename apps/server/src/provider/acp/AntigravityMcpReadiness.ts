// @effect-diagnostics nodeBuiltinImport:off -- lstat/stat inspect mtimes on agy's MCP cache and logs.
import * as NodeFSP from "node:fs/promises";

import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_QUIESCENCE_MS = 150;
const DEFAULT_POLL_INTERVAL_MS = 50;
const MAX_CONFIG_BYTES = 1_000_000;
const MAX_LOG_READ_BYTES = 262_144;

const McpConfigFile = Schema.fromJsonString(
  Schema.Struct({
    mcpServers: Schema.optional(
      Schema.Record(
        Schema.String,
        Schema.Struct({
          disabled: Schema.optional(Schema.Boolean),
        }),
      ),
    ),
  }),
);
const decodeMcpConfig = Schema.decodeUnknownOption(McpConfigFile);

const PluginConfigFile = Schema.fromJsonString(
  Schema.Struct({
    plugins: Schema.optional(
      Schema.Record(Schema.String, Schema.Struct({ enabled: Schema.optional(Schema.Boolean) })),
    ),
  }),
);
const decodePluginConfig = Schema.decodeUnknownOption(PluginConfigFile);

const PluginManifestFile = Schema.fromJsonString(
  Schema.Struct({
    disabled: Schema.optional(Schema.Boolean),
  }),
);
const decodePluginManifest = Schema.decodeUnknownOption(PluginManifestFile);

// Matches agy 1.5.x Go glog lines such as:
// W1125 14:09:40.594808 305 connector.go:131] MCP server structural-biology_structure_viewer_mcp: exec: "agy-node": executable file not found in $PATH
const CONNECTOR_FAILURE_LINE =
  /^[WE]\d{4}\s+\d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+connector\.go:\d+\]\s+MCP server\s+(?<server>[^\s:]+):/gm;

const ACP_SERVER_LOG_NAME = /^acp-server-.*\.log$/;

const readSmallFile = Effect.fn("AntigravityMcpReadiness.readSmallFile")(function* (
  filePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(filePath).pipe(Effect.orElseSucceed(() => undefined));
  if (info?.type !== "File" || info.size > BigInt(MAX_CONFIG_BYTES)) return undefined;
  return yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => undefined));
});

const readEnabledMcpServerNames = Effect.fn("AntigravityMcpReadiness.readEnabledMcpServerNames")(
  function* (configPath: string, prefix?: string) {
    const raw = yield* readSmallFile(configPath);
    if (raw === undefined) return [] as ReadonlyArray<string>;
    const parsed = decodeMcpConfig(raw);
    if (parsed._tag !== "Some" || parsed.value.mcpServers === undefined) {
      return [] as ReadonlyArray<string>;
    }
    const names: Array<string> = [];
    for (const [serverName, entry] of Object.entries(parsed.value.mcpServers)) {
      if (entry.disabled === true) continue;
      if (prefix === undefined && serverName === "t3-code") continue;
      names.push(prefix === undefined ? serverName : `${prefix}_${serverName}`);
    }
    return names;
  },
);

const isPluginDisabledByManifest = Effect.fn("AntigravityMcpReadiness.isPluginDisabledByManifest")(
  function* (pluginDir: string) {
    const path = yield* Path.Path;
    const raw = yield* readSmallFile(path.join(pluginDir, "plugin.json"));
    if (raw === undefined) return false;
    const parsed = decodePluginManifest(raw);
    return parsed._tag === "Some" && parsed.value.disabled === true;
  },
);

/**
 * Resolves external MCP servers that `agy acp` will connect to asynchronously in Lazy mode:
 * profile `config/mcp_config.json`, enabled `config/plugins/<plugin>/mcp_config.json`, and
 * workspace `.agents/plugins/<plugin>/mcp_config.json`.
 */
export const resolveExpectedAntigravityExternalMcpServers = Effect.fn(
  "resolveExpectedAntigravityExternalMcpServers",
)(function* (input: {
  readonly profileDirectory: string;
  readonly cwd: string;
}): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const expected = new Set<string>();

  const profileConfigDir = path.join(input.profileDirectory, "config");
  for (const name of yield* readEnabledMcpServerNames(
    path.join(profileConfigDir, "mcp_config.json"),
  )) {
    expected.add(name);
  }

  const rawProfileConfig = yield* readSmallFile(path.join(profileConfigDir, "config.json"));
  const profilePrefs =
    rawProfileConfig === undefined
      ? {}
      : (() => {
          const decoded = decodePluginConfig(rawProfileConfig);
          return decoded._tag === "Some" ? (decoded.value.plugins ?? {}) : {};
        })();

  const profilePluginsDir = path.join(profileConfigDir, "plugins");
  const profilePlugins = yield* fs
    .readDirectory(profilePluginsDir)
    .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
  for (const pluginName of profilePlugins) {
    if (pluginName.startsWith(".")) continue;
    const pluginDir = path.join(profilePluginsDir, pluginName);
    const stat = yield* fs.stat(pluginDir).pipe(Effect.orElseSucceed(() => undefined));
    if (stat?.type !== "Directory") continue;
    const pref = profilePrefs[pluginName];
    const manifestDisabled = yield* isPluginDisabledByManifest(pluginDir);
    const enabled = pref?.enabled === true || (pref?.enabled !== false && !manifestDisabled);
    if (!enabled) continue;
    for (const name of yield* readEnabledMcpServerNames(
      path.join(pluginDir, "mcp_config.json"),
      pluginName,
    )) {
      expected.add(name);
    }
  }

  const workspacePluginsDir = path.resolve(input.cwd, ".agents", "plugins");
  const workspacePlugins = yield* fs
    .readDirectory(workspacePluginsDir)
    .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
  for (const pluginName of workspacePlugins) {
    if (pluginName.startsWith(".")) continue;
    const pluginDir = path.join(workspacePluginsDir, pluginName);
    const stat = yield* fs.stat(pluginDir).pipe(Effect.orElseSucceed(() => undefined));
    if (stat?.type !== "Directory") continue;
    if (yield* isPluginDisabledByManifest(pluginDir)) continue;
    for (const name of yield* readEnabledMcpServerNames(
      path.join(pluginDir, "mcp_config.json"),
      pluginName,
    )) {
      expected.add(name);
    }
  }

  return [...expected].toSorted();
});

export interface AntigravityMcpCacheSnapshot {
  readonly expectedServers: ReadonlyArray<string>;
  readonly baselineMtimeMs: ReadonlyMap<string, number | undefined>;
  readonly existingLogFiles: ReadonlySet<string>;
}

const maxServerCacheMtimeMs = (serverCacheDir: string) =>
  Effect.tryPromise({
    try: async () => {
      const dirStat = await NodeFSP.stat(serverCacheDir);
      if (!dirStat.isDirectory()) return undefined;
      let maxMtime = dirStat.mtimeMs;
      const entries = await NodeFSP.readdir(serverCacheDir);
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        try {
          const entryStat = await NodeFSP.stat(`${serverCacheDir}/${entry}`);
          if (entryStat.mtimeMs > maxMtime) maxMtime = entryStat.mtimeMs;
        } catch {
          // Ignore races while agy writes or rotates files.
        }
      }
      return maxMtime;
    },
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => undefined));

/** Captures pre-spawn mtimes and log filenames so readiness only observes this fresh process. */
export const snapshotAntigravityMcpCache = Effect.fn("snapshotAntigravityMcpCache")(
  function* (input: {
    readonly profileDirectory: string;
    readonly cwd: string;
  }): Effect.fn.Return<AntigravityMcpCacheSnapshot, never, FileSystem.FileSystem | Path.Path> {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const expectedServers = yield* resolveExpectedAntigravityExternalMcpServers(input);
    const baselineMtimeMs = new Map<string, number | undefined>();
    if (expectedServers.length === 0) {
      return { expectedServers, baselineMtimeMs, existingLogFiles: new Set() };
    }
    const acpDir = path.join(input.profileDirectory, "antigravity-acp");
    for (const server of expectedServers) {
      baselineMtimeMs.set(server, yield* maxServerCacheMtimeMs(path.join(acpDir, "mcp", server)));
    }
    const logDir = path.join(acpDir, "log");
    const existingLogs = yield* fs
      .readDirectory(logDir)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
    const existingLogFiles = new Set(existingLogs.filter((name) => ACP_SERVER_LOG_NAME.test(name)));
    return { expectedServers, baselineMtimeMs, existingLogFiles };
  },
);

const readFailedServersFromNewLogs = Effect.fn(
  "AntigravityMcpReadiness.readFailedServersFromNewLogs",
)(function* (
  logDir: string,
  existingLogFiles: ReadonlySet<string>,
  pendingServers: ReadonlySet<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs
    .readDirectory(logDir)
    .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
  const failed = new Set<string>();
  for (const entry of entries) {
    if (!ACP_SERVER_LOG_NAME.test(entry) || existingLogFiles.has(entry)) continue;
    const logPath = path.join(logDir, entry);
    const text = yield* Effect.tryPromise({
      try: async () => {
        const handle = await NodeFSP.open(logPath, "r");
        try {
          const stat = await handle.stat();
          const size = Number(stat.size);
          const length = Math.min(size, MAX_LOG_READ_BYTES);
          const offset = Math.max(0, size - length);
          const buffer = Buffer.alloc(length);
          await handle.read(buffer, 0, length, offset);
          return buffer.toString("utf8");
        } finally {
          await handle.close();
        }
      },
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined));
    if (text === undefined) continue;
    CONNECTOR_FAILURE_LINE.lastIndex = 0;
    for (const match of text.matchAll(CONNECTOR_FAILURE_LINE)) {
      const server = match.groups?.server;
      if (server !== undefined && pendingServers.has(server)) {
        failed.add(server);
      }
    }
  }
  return failed;
});

/**
 * Waits once per fresh `agy` process for expected Lazy external MCP servers to refresh their tool
 * cache (with quiescence debounce) or log a `connector.go` failure, bounded by a non-fatal cap.
 */
export const waitForAntigravityExternalMcpReadiness = Effect.fn(
  "waitForAntigravityExternalMcpReadiness",
)(function* (input: {
  readonly profileDirectory: string;
  readonly snapshot: AntigravityMcpCacheSnapshot;
  readonly timeoutMs?: number;
  readonly quiescenceMs?: number;
  readonly pollIntervalMs?: number;
  readonly reportStartupPhase?: (phase: string | undefined) => Effect.Effect<void>;
}): Effect.fn.Return<
  {
    readonly ready: ReadonlyArray<string>;
    readonly failed: ReadonlyArray<string>;
    readonly timedOut: ReadonlyArray<string>;
  },
  never,
  FileSystem.FileSystem | Path.Path
> {
  const { snapshot } = input;
  if (snapshot.expectedServers.length === 0) {
    return { ready: [], failed: [], timedOut: [] };
  }
  const path = yield* Path.Path;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const quiescenceMs = input.quiescenceMs ?? DEFAULT_QUIESCENCE_MS;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const acpDir = path.join(input.profileDirectory, "antigravity-acp");
  const mcpDir = path.join(acpDir, "mcp");
  const logDir = path.join(acpDir, "log");

  const pending = new Set(snapshot.expectedServers);
  const ready = new Set<string>();
  const failed = new Set<string>();
  const observedMtime = new Map<
    string,
    { readonly mtimeMs: number; readonly changedAtMs: number }
  >();

  const startedAtMs = yield* Clock.currentTimeMillis;

  return yield* Effect.gen(function* () {
    if (input.reportStartupPhase !== undefined) {
      yield* input.reportStartupPhase("mcp");
    }

    while (pending.size > 0) {
      const nowMs = yield* Clock.currentTimeMillis;

      for (const server of pending) {
        const baseline = snapshot.baselineMtimeMs.get(server);
        const current = yield* maxServerCacheMtimeMs(path.join(mcpDir, server));
        if (current !== undefined && (baseline === undefined || current > baseline)) {
          const previous = observedMtime.get(server);
          if (previous === undefined || current > previous.mtimeMs) {
            observedMtime.set(server, { mtimeMs: current, changedAtMs: nowMs });
          } else if (nowMs - previous.changedAtMs >= quiescenceMs) {
            ready.add(server);
            pending.delete(server);
          }
        }
      }

      if (pending.size > 0) {
        const newlyFailed = yield* readFailedServersFromNewLogs(
          logDir,
          snapshot.existingLogFiles,
          pending,
        );
        for (const server of newlyFailed) {
          failed.add(server);
          pending.delete(server);
        }
      }

      if (pending.size === 0) break;
      if (nowMs - startedAtMs >= timeoutMs) {
        yield* Effect.logWarning(
          "Timed out waiting for Antigravity external MCP servers to settle before Turn 1.",
          {
            pendingServers: [...pending].toSorted(),
            readyServers: [...ready].toSorted(),
            failedServers: [...failed].toSorted(),
            timeoutMs,
          },
        );
        break;
      }
      yield* Effect.sleep(Duration.millis(pollIntervalMs));
    }

    return {
      ready: [...ready].toSorted(),
      failed: [...failed].toSorted(),
      timedOut: [...pending].toSorted(),
    };
  }).pipe(
    Effect.ensuring(
      input.reportStartupPhase === undefined ? Effect.void : input.reportStartupPhase(undefined),
    ),
  );
});
