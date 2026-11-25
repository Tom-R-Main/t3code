// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's symlink has no type argument, and Windows needs a junction to link without elevation.
import * as NodeFSP from "node:fs/promises";

import type { AntigravityAuthMethod, ProviderInstanceId } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveNodeExecutable, nodeRuntimeUnavailableMessage } from "@t3tools/shared/nodeRuntime";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as AcpErrors from "effect-acp/errors";

import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  antigravityUserSkillDirectories,
  readAntigravityPlugins,
  resolveAntigravityUserHome,
} from "./Drivers/AntigravitySkills.ts";

export const ANTIGRAVITY_AUTH_STDOUT_PREFIX =
  "Open the following link to authenticate the ACP server: ";
export const ANTIGRAVITY_AUTH_BROWSER_MARKER = "__T3_ANTIGRAVITY_AUTH_URL__";
export const ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE =
  "Sign in to Antigravity in Settings before you continue.";

const maxAuthorizationUrlLength = 16_384;
const maxBrowserHelperLineLength =
  Math.max(ANTIGRAVITY_AUTH_BROWSER_MARKER.length, ANTIGRAVITY_AUTH_STDOUT_PREFIX.length) +
  maxAuthorizationUrlLength +
  2;
const maxStdoutLineBytes = 16 * 1024 * 1024;
const authPrefixBytes = new TextEncoder().encode(ANTIGRAVITY_AUTH_STDOUT_PREFIX);
const decodeUrl = Schema.decodeUnknownEffect(Schema.URLFromString);
const decodeBrowserHelperUrl = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.String));
const ProfileSettingsFile = Schema.Struct({
  auth: Schema.Struct({ type: Schema.String }),
  gcp: Schema.optional(
    Schema.Struct({
      project: Schema.optional(Schema.String),
      location: Schema.optional(Schema.String),
    }),
  ),
});
const encodeProfileSettings = Schema.encodeSync(Schema.fromJsonString(ProfileSettingsFile));
const isAcpRequestError = Schema.is(AcpErrors.AcpRequestError);
const isAcpTransportError = Schema.is(AcpErrors.AcpTransportError);

// Python splits BROWSER on path separators before parsing quotes. Exit 0 on EPIPE to prevent browser fallback after cancellation.
const browserHelperSource =
  `process.stderr.on("error",()=>process.exit(0)).write(` +
  `"${ANTIGRAVITY_AUTH_BROWSER_MARKER}"+JSON.stringify(process.argv[1])+"\\n",` +
  `()=>process.exit(0))`;
const browserPreflightUrl = "https://example.invalid/t3-antigravity-browser-preflight";

const removedEnvironmentKeys = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "AGY_ACP_CCPA_PROJECT",
  "AGY_ACP_ENABLE_OAUTH",
  "GEMINI_HOME",
  "AGY_ACP_FORCE_FILE_STORAGE",
  "AGY_CLI_FORCE_FILE_TOKEN_STORAGE",
  "AGY_CLI_DISABLE_AUTO_UPDATE",
  "BROWSER",
  "PYTHONUNBUFFERED",
  "ELECTRON_RUN_AS_NODE",
  // An inherited pipe whose owner exited makes Electron-as-Node print Crashpad errors to stderr.
  "CHROME_CRASHPAD_PIPE_NAME",
]);

export interface AntigravityProfile {
  readonly platform: NodeJS.Platform;
  readonly geminiHome: string;
  readonly acpDirectory: string;
  readonly tokenPath: string;
  readonly tempDirectory: string;
  readonly browserCommand: string;
  readonly caBundlePath?: string;
}

export interface AntigravityAuthConfig {
  readonly authMethod: AntigravityAuthMethod;
  readonly apiKey: string;
  readonly gcpProject: string;
  readonly gcpLocation: string;
}

const ANTIGRAVITY_PERSONAL_AUTH: AntigravityAuthConfig = {
  authMethod: "oauth-personal",
  apiKey: "",
  gcpProject: "",
  gcpLocation: "",
};

export function antigravityAuthUsesBrowser(authMethod: AntigravityAuthMethod): boolean {
  return authMethod === "oauth-personal" || authMethod === "oauth-business";
}

export function antigravityAuthLabel(authMethod: AntigravityAuthMethod): string {
  switch (authMethod) {
    case "oauth-personal":
      return "Google account";
    case "oauth-business":
      return "Gemini Enterprise";
    case "gemini-api-key":
      return "Gemini API key";
    case "agent-platform":
      return "Agent Platform";
  }
}

export function antigravityAuthConfigIssue(auth: AntigravityAuthConfig): string | null {
  switch (auth.authMethod) {
    case "oauth-personal":
      return null;
    case "oauth-business":
      return auth.gcpProject && auth.gcpLocation
        ? null
        : "Gemini Enterprise needs a GCP project and location in the Antigravity provider settings.";
    case "gemini-api-key":
      return auth.apiKey ? null : "Enter a Gemini API key in the Antigravity provider settings.";
    case "agent-platform":
      return auth.apiKey || (auth.gcpProject && auth.gcpLocation)
        ? null
        : "Agent Platform needs an API key, or a GCP project and location, in the Antigravity provider settings.";
  }
}

/**
 * `auth.type` names the selected method so a native logout clears only that method's credentials
 * instead of every stored token. Never holds a credential.
 */
function antigravityProfileSettings(auth: AntigravityAuthConfig): string {
  const gcp = {
    ...(auth.gcpProject ? { project: auth.gcpProject } : {}),
    ...(auth.gcpLocation ? { location: auth.gcpLocation } : {}),
  };
  return `${encodeProfileSettings({
    auth: { type: auth.authMethod },
    ...(Object.keys(gcp).length > 0 ? { gcp } : {}),
  })}\n`;
}

export interface AntigravityAuthorizationUrl {
  readonly authorizationUrl: string;
  readonly redirectUri: string;
  readonly state: string;
}

function authSupportError(detail: string) {
  return new AcpErrors.AcpTransportError({ detail, cause: undefined });
}

// The 1.5 CLI answers `authenticate` with this internal error when it has no sign-in and no display.
const NATIVE_CLI_NO_BROWSER_PREFIX = "No browser is available here";

export function isAntigravitySignInRequiredError(error: unknown): boolean {
  return (
    (isAcpRequestError(error) &&
      (error.code === -32000 ||
        (error.code === -32603 && error.errorMessage.startsWith(NATIVE_CLI_NO_BROWSER_PREFIX)))) ||
    (isAcpTransportError(error) && error.detail === ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE)
  );
}

export interface AntigravityInstanceDirectories {
  readonly profile: string;
  /** Keep beside the profile: 120-character archive members under its longer name would exceed Windows' 260-character limit. */
  readonly runtimeTemp: string;
}

/** Hashes the instance ID so case-only differences stay separate on case-insensitive filesystems. */
export const resolveAntigravityInstanceDirectories = Effect.fn(
  "resolveAntigravityInstanceDirectories",
)(function* (stateDir: string, instanceId: ProviderInstanceId) {
  const digest = yield* Digest.Digest;
  const path = yield* Path.Path;
  const key = Hex.encode(yield* digest.digest(Digest.sha256, new TextEncoder().encode(instanceId)));
  return {
    profile: path.join(stateDir, "providers", "antigravity", key),
    runtimeTemp: path.join(stateDir, "antigravity-tmp", key.slice(0, 12)),
  } satisfies AntigravityInstanceDirectories;
});

function quoteBrowserArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function antigravityEnvironment(
  profile: AntigravityProfile,
  baseEnv: NodeJS.ProcessEnv,
  auth: AntigravityAuthConfig,
  runtimeTempDirectory?: string,
) {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    // Windows treats environment keys as case-insensitive. Remove aliases too.
    if (!removedEnvironmentKeys.has(key.toUpperCase())) environment[key] = value;
  }
  // Put the GCP pair in settings.json because GOOGLE_API_KEY takes precedence in the environment.
  const credential =
    auth.authMethod === "gemini-api-key" && auth.apiKey
      ? { GEMINI_API_KEY: auth.apiKey }
      : auth.authMethod === "agent-platform" && auth.apiKey
        ? { GOOGLE_API_KEY: auth.apiKey }
        : {};
  // Each launch unpacks about 1 GB; use T3-owned temp so the driver can reclaim files after force-kill.
  const tempDirectory = runtimeTempDirectory ?? profile.tempDirectory;
  return {
    ...environment,
    ...credential,
    ...(profile.caBundlePath !== undefined &&
    baseEnv.SSL_CERT_FILE === undefined &&
    baseEnv.SSL_CERT_DIR === undefined
      ? { SSL_CERT_FILE: profile.caBundlePath }
      : {}),
    // The 1.5.12–1.5.15 CLI isolates file storage via SSH_CONNECTION; 1.5.16+ requires
    // AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1 (and still uses SSH_CONNECTION for headless detection).
    ...(auth.authMethod === "oauth-personal"
      ? {
          SSH_CONNECTION: baseEnv.SSH_CONNECTION || "127.0.0.1 0 127.0.0.1 0",
          AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "1",
        }
      : {}),
    GEMINI_HOME: profile.geminiHome,
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    // agy's troubleshooting docs specify "true"; the interactive CLI keeps self-updating with "1".
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    BROWSER: profile.browserCommand,
    PYTHONUNBUFFERED: "1",
    ELECTRON_RUN_AS_NODE: "1",
    ...(profile.platform === "win32"
      ? { TEMP: tempDirectory, TMP: tempDirectory }
      : { TMPDIR: tempDirectory }),
  };
}

class AntigravitySkillLinkError extends Schema.TaggedError<AntigravitySkillLinkError>()(
  "AntigravitySkillLinkError",
  { link: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not link Antigravity user configuration at ${this.link}.`;
  }
}

const antigravityUserConfigFiles = [
  ["AGENTS.md"],
  ["GEMINI.md"],
  ["config", "skills.json"],
] as const;

/** Private GEMINI_HOME isolates credentials/hooks/MCP; link global skills and rules from the real ~/.gemini. */
const linkAntigravityUserConfig = Effect.fn("linkAntigravityUserConfig")(function* (input: {
  readonly profileDirectory: string;
  readonly userHome: string;
  readonly platform: NodeJS.Platform;
}): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const userGemini = path.join(input.userHome, ".gemini");
  const links = antigravityUserSkillDirectories(path, input.profileDirectory);
  const targets = antigravityUserSkillDirectories(path, userGemini);
  const directoryType = input.platform === "win32" ? "junction" : "dir";
  for (const [link, target, type] of [
    [links[0], targets[0], directoryType],
    [links[1], targets[1], directoryType],
    // File symlinks need elevation or Developer Mode on Windows, so config files are copied there.
    ...(input.platform === "win32"
      ? []
      : antigravityUserConfigFiles.map(
          (segments) =>
            [
              path.join(input.profileDirectory, ...segments),
              path.join(userGemini, ...segments),
              "file",
            ] as const,
        )),
  ] as const) {
    yield* Effect.gen(function* () {
      // The harness creates these folders itself, and mkdir fails on a dangling link.
      if (!(yield* fs.exists(target))) {
        const linked = yield* fs.readLink(link).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (linked) yield* fs.remove(link);
        return;
      }
      const existing = yield* fs.readLink(link).pipe(
        Effect.map((value): string | undefined => path.resolve(path.dirname(link), value)),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined),
        // An empty folder is the harness's placeholder from a launch without the link.
        // rmdir refuses a non-empty folder, so content added meanwhile is never deleted.
        Effect.catch((error) =>
          Effect.tryPromise({
            try: () => NodeFSP.rmdir(link),
            catch: (cause) => new AntigravitySkillLinkError({ link, cause }),
          }).pipe(
            Effect.as(undefined),
            Effect.mapError(() => error),
          ),
        ),
      );
      if (existing === target) return;
      if (existing !== undefined) {
        yield* fs.remove(link);
      }
      yield* fs.makeDirectory(path.dirname(link), { recursive: true });
      yield* Effect.tryPromise({
        try: () => NodeFSP.symlink(target, link, type),
        catch: (cause) => new AntigravitySkillLinkError({ link, cause }),
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Antigravity user configuration is not linked into the profile.", {
          link,
          target,
          error,
        }),
      ),
    );
  }
});

const RuleCopiesJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const decodeRuleCopies = Schema.decodeUnknownOption(RuleCopiesJson);
const encodeRuleCopies = Schema.encodeSync(RuleCopiesJson);

const PluginLinkManifestJson = Schema.fromJsonString(
  Schema.Struct({
    linkedPlugins: Schema.Array(Schema.String),
    enabledOverrides: Schema.Array(Schema.String),
  }),
);
const decodePluginLinkManifest = Schema.decodeUnknownOption(PluginLinkManifestJson);
const encodePluginLinkManifest = Schema.encodeSync(PluginLinkManifestJson);
const GenericJsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeGenericJsonObject = Schema.decodeUnknownOption(GenericJsonObject);
const encodeGenericJsonObject = Schema.encodeSync(GenericJsonObject);

const lstatOrUndefined = (targetPath: string) =>
  Effect.tryPromise({
    try: () => NodeFSP.lstat(targetPath),
    catch: (cause) => new AntigravitySkillLinkError({ link: targetPath, cause }),
  }).pipe(Effect.orElseSucceed(() => undefined));

/**
 * Links enabled global user plugins individually into `<profile>/config/plugins/<name>` while
 * preserving profile-local plugins, pruning stale T3-owned links, and syncing `enabled: true`
 * overrides for manifests that ship `disabled: true`.
 */
const linkAntigravityUserPlugins = Effect.fn("linkAntigravityUserPlugins")(function* (input: {
  readonly profileDirectory: string;
  readonly userHome: string;
  readonly platform: NodeJS.Platform;
}): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const profileConfigDir = path.join(input.profileDirectory, "config");
  const profilePluginsDir = path.join(profileConfigDir, "plugins");
  const pluginsDirStat = yield* lstatOrUndefined(profilePluginsDir);
  if (pluginsDirStat?.isSymbolicLink()) {
    yield* Effect.logWarning(
      "Skipping Antigravity plugin linking because the profile plugins directory is itself a symlink.",
      { profilePluginsDir },
    );
    return;
  }
  if (pluginsDirStat !== undefined && !pluginsDirStat.isDirectory()) {
    yield* Effect.logWarning(
      "Skipping Antigravity plugin linking because the profile plugins path is not a directory.",
      { profilePluginsDir },
    );
    return;
  }

  const resolved = yield* readAntigravityPlugins({
    userHome: input.userHome,
    profileDirectory: input.profileDirectory,
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not read Antigravity user plugins.", { error }).pipe(
        Effect.as(undefined),
      ),
    ),
  );
  if (resolved === undefined) return;

  const manifestPath = path.join(input.profileDirectory, ".t3-plugin-links.json");
  const previousText = yield* fs
    .readFileString(manifestPath)
    .pipe(Effect.orElseSucceed((): string | undefined => undefined));
  const previous = Option.getOrElse(decodePluginLinkManifest(previousText), () => ({
    linkedPlugins: [] as ReadonlyArray<string>,
    enabledOverrides: [] as ReadonlyArray<string>,
  }));
  const previousLinked = new Set(previous.linkedPlugins);
  const previousOverrides = new Set(previous.enabledOverrides);
  const desiredByName = new Map(resolved.userPlugins.map((plugin) => [plugin.name, plugin]));
  const directoryType = input.platform === "win32" ? "junction" : "dir";

  for (const staleName of previousLinked) {
    if (desiredByName.has(staleName)) continue;
    const staleLink = path.join(profilePluginsDir, staleName);
    const stat = yield* lstatOrUndefined(staleLink);
    if (stat?.isSymbolicLink()) {
      yield* fs.remove(staleLink).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not prune stale Antigravity plugin link.", {
            staleLink,
            error,
          }),
        ),
      );
    }
  }

  const nextLinked = new Set<string>();
  const nextOverrides = new Set<string>();
  for (const [name, plugin] of desiredByName) {
    const linkPath = path.join(profilePluginsDir, name);
    const stat = yield* lstatOrUndefined(linkPath);
    if (stat === undefined) {
      yield* Effect.gen(function* () {
        yield* fs.makeDirectory(profilePluginsDir, { recursive: true });
        yield* Effect.tryPromise({
          try: () => NodeFSP.symlink(plugin.directory, linkPath, directoryType),
          catch: (cause) => new AntigravitySkillLinkError({ link: linkPath, cause }),
        });
        nextLinked.add(name);
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Antigravity user plugin is not linked into the profile.", {
            link: linkPath,
            target: plugin.directory,
            error,
          }),
        ),
      );
    } else if (stat.isSymbolicLink()) {
      const existingTarget = yield* fs.readLink(linkPath).pipe(
        Effect.map((value) => path.resolve(path.dirname(linkPath), value)),
        Effect.orElseSucceed((): string | undefined => undefined),
      );
      if (existingTarget === plugin.directory) {
        nextLinked.add(name);
      } else if (previousLinked.has(name)) {
        yield* Effect.gen(function* () {
          yield* fs.remove(linkPath);
          yield* Effect.tryPromise({
            try: () => NodeFSP.symlink(plugin.directory, linkPath, directoryType),
            catch: (cause) => new AntigravitySkillLinkError({ link: linkPath, cause }),
          });
          nextLinked.add(name);
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not refresh Antigravity user plugin link.", {
              link: linkPath,
              target: plugin.directory,
              error,
            }),
          ),
        );
      }
    }
    if (nextLinked.has(name) && plugin.manifestDisabled && plugin.userExplicitlyEnabled) {
      nextOverrides.add(name);
    }
  }

  const overridesToRemove = [...previousOverrides].filter((name) => !nextOverrides.has(name));
  if (nextOverrides.size > 0 || overridesToRemove.length > 0) {
    const profileConfigPath = path.join(profileConfigDir, "config.json");
    yield* Effect.gen(function* () {
      const rawConfig = yield* fs
        .readFileString(profileConfigPath)
        .pipe(Effect.orElseSucceed((): string | undefined => undefined));
      const root: Record<string, unknown> =
        rawConfig === undefined
          ? {}
          : { ...Option.getOrElse(decodeGenericJsonObject(rawConfig), () => ({})) };
      const existingPlugins =
        typeof root.plugins === "object" && root.plugins !== null && !Array.isArray(root.plugins)
          ? { ...(root.plugins as Record<string, unknown>) }
          : {};
      let changed = false;
      for (const name of overridesToRemove) {
        const entry = existingPlugins[name];
        if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
          const copy = { ...(entry as Record<string, unknown>) };
          if (copy.enabled === true) {
            delete copy.enabled;
            changed = true;
            if (Object.keys(copy).length === 0) {
              delete existingPlugins[name];
            } else {
              existingPlugins[name] = copy;
            }
          }
        }
      }
      for (const name of nextOverrides) {
        const entry = existingPlugins[name];
        const copy =
          typeof entry === "object" && entry !== null && !Array.isArray(entry)
            ? { ...(entry as Record<string, unknown>) }
            : {};
        if (copy.enabled !== true) {
          copy.enabled = true;
          existingPlugins[name] = copy;
          changed = true;
        }
      }
      if (!changed) return;
      if (Object.keys(existingPlugins).length === 0) {
        delete root.plugins;
      } else {
        root.plugins = existingPlugins;
      }
      yield* fs.makeDirectory(profileConfigDir, { recursive: true });
      yield* writeFileStringAtomically({
        filePath: profileConfigPath,
        contents: `${encodeGenericJsonObject(root)}\n`,
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not sync Antigravity profile plugin overrides.", { error }),
      ),
    );
  }

  const nextManifest = {
    linkedPlugins: [...nextLinked].toSorted(),
    enabledOverrides: [...nextOverrides].toSorted(),
  };
  const manifestChanged =
    nextManifest.linkedPlugins.length !== previous.linkedPlugins.length ||
    nextManifest.enabledOverrides.length !== previous.enabledOverrides.length ||
    nextManifest.linkedPlugins.some((name, index) => name !== previous.linkedPlugins[index]) ||
    nextManifest.enabledOverrides.some((name, index) => name !== previous.enabledOverrides[index]);
  if (manifestChanged || (previousText !== undefined && nextManifest.linkedPlugins.length > 0)) {
    yield* writeFileStringAtomically({
      filePath: manifestPath,
      contents: `${encodePluginLinkManifest(nextManifest)}\n`,
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Antigravity plugin link record could not be written.", { error }),
      ),
    );
  }
});

/** Copies refresh each launch; the recorded copy keeps a file the profile owns or edited untouched. */
const copyAntigravityUserConfigFiles = Effect.fn("copyAntigravityUserConfigFiles")(
  function* (input: {
    readonly profileDirectory: string;
    readonly userHome: string;
  }): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const manifestPath = path.join(input.profileDirectory, ".t3-rule-copies.json");
    const readOptional = (file: string) =>
      fs.readFileString(file).pipe(Effect.orElseSucceed((): string | undefined => undefined));
    const manifestText = yield* readOptional(manifestPath);
    const copies: Record<string, string> = {
      ...Option.getOrElse(decodeRuleCopies(manifestText), () => ({})),
    };
    for (const segments of antigravityUserConfigFiles) {
      const key = segments.join("/");
      const link = path.join(input.profileDirectory, ...segments);
      const target = path.join(input.userHome, ".gemini", ...segments);
      yield* Effect.gen(function* () {
        const current = yield* readOptional(link);
        if (current !== undefined && current !== copies[key]) {
          delete copies[key];
          return;
        }
        const source = yield* readOptional(target);
        if (source === undefined) {
          if (current !== undefined) yield* fs.remove(link);
          delete copies[key];
          return;
        }
        yield* fs.makeDirectory(path.dirname(link), { recursive: true });
        yield* fs.writeFileString(link, source);
        copies[key] = source;
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Antigravity user configuration is not copied into the profile.", {
            link,
            target,
            error,
          }),
        ),
      );
    }
    yield* fs
      .writeFileString(manifestPath, encodeRuleCopies(copies))
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Antigravity rule copy record could not be written.", { error }),
        ),
      );
  },
);

/** Sibling directory used for auth-only helper processes (title generation, model refresh). */
export function resolveAntigravityHelperProfileDirectory(
  path: Path.Path,
  profileDirectory: string,
): string {
  return `${path.resolve(profileDirectory)}-helper`;
}

const prepareAntigravityProfileBase = Effect.fn("prepareAntigravityProfileBase")(function* (input: {
  readonly profileDirectory: string;
  readonly geminiHome?: string;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly runtimeExecutablePath?: string;
  readonly platform?: NodeJS.Platform;
  readonly auth?: AntigravityAuthConfig;
  readonly tempDirectory?: string;
}) {
  const auth = input.auth ?? ANTIGRAVITY_PERSONAL_AUTH;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = input.platform ?? (yield* HostProcess.Platform);
  const runtimeExecutablePath =
    input.runtimeExecutablePath ??
    (yield* resolveNodeExecutable("Antigravity sign-in", input.baseEnv).pipe(
      Effect.mapError(
        (cause) =>
          new AcpErrors.AcpTransportError({
            detail: nodeRuntimeUnavailableMessage("Antigravity sign-in"),
            cause,
          }),
      ),
    ));
  const helperExecutable =
    platform === "win32" ? runtimeExecutablePath.replaceAll("\\", "/") : runtimeExecutablePath;
  const browserArguments = [helperExecutable, "-e", browserHelperSource, "--", "%s"];
  const browserCommand = browserArguments.map(quoteBrowserArgument).join(" ");
  if (
    browserCommand.includes(platform === "win32" ? ";" : ":") ||
    helperExecutable.includes("\r") ||
    helperExecutable.includes("\n") ||
    helperExecutable.includes("\0") ||
    helperExecutable.includes("%s")
  ) {
    return yield* authSupportError(
      "The T3 runtime path cannot be used to suppress Antigravity browser launches.",
    );
  }

  const realProfileDirectory = path.resolve(input.profileDirectory);
  const realAcpDirectory = path.join(realProfileDirectory, "antigravity-acp");
  const geminiHome = input.geminiHome ? path.resolve(input.geminiHome) : realProfileDirectory;
  const acpDirectory = path.join(geminiHome, "antigravity-acp");
  const tempDirectory = input.tempDirectory ?? path.join(realAcpDirectory, "tmp");
  let caBundlePath: string | undefined;
  if (platform === "linux") {
    // Bundled Python may look for certificates at paths absent on this distribution.
    // Relative paths would resolve differently when the agent runs in the project directory.
    for (const candidate of [
      (input.baseEnv ?? process.env).NIX_SSL_CERT_FILE,
      "/etc/ssl/certs/ca-bundle.crt",
      "/etc/ssl/certs/ca-certificates.crt",
      "/etc/pki/tls/certs/ca-bundle.crt",
      "/etc/ssl/cert.pem",
    ]) {
      if (
        candidate &&
        path.isAbsolute(candidate) &&
        (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false)))
      ) {
        caBundlePath = candidate;
        break;
      }
    }
  }
  const profile: AntigravityProfile = {
    platform,
    geminiHome,
    acpDirectory,
    tokenPath: path.join(realAcpDirectory, "acp_token.json"),
    tempDirectory,
    browserCommand,
    ...(caBundlePath === undefined ? {} : { caBundlePath }),
  };
  const environment = antigravityEnvironment(profile, input.baseEnv ?? process.env, auth);
  yield* Effect.gen(function* () {
    const child = yield* spawner.spawn(
      ChildProcess.make(helperExecutable, ["-e", browserHelperSource, "--", browserPreflightUrl], {
        env: environment,
        extendEnv: false,
        shell: false,
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: 4_096 }),
        collectUint8StreamText({ stream: child.stderr, maxBytes: 4_096 }),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (
      Number(exitCode) !== 0 ||
      stdout.bytes !== 0 ||
      stdout.truncated ||
      stderr.truncated ||
      stderr.text !== `${ANTIGRAVITY_AUTH_BROWSER_MARKER}"${browserPreflightUrl}"\n`
    ) {
      return yield* authSupportError("Antigravity browser suppression could not be verified.");
    }
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () =>
        Effect.fail(authSupportError("Antigravity browser suppression verification timed out.")),
    }),
    Effect.mapError((error) =>
      error._tag === "AcpTransportError"
        ? error
        : authSupportError("Antigravity browser suppression could not be verified."),
    ),
  );

  for (const directory of [realProfileDirectory, realAcpDirectory, tempDirectory]) {
    yield* fs
      .makeDirectory(directory, { recursive: true, mode: 0o700 })
      .pipe(
        Effect.mapError(() =>
          authSupportError("The Antigravity profile directory could not be created."),
        ),
      );
    if (platform !== "win32") {
      yield* fs
        .chmod(directory, 0o700)
        .pipe(
          Effect.mapError(() =>
            authSupportError("The Antigravity profile directory permissions could not be set."),
          ),
        );
    }
  }
  yield* writeFileStringAtomically({
    filePath: path.join(realAcpDirectory, "settings.json"),
    contents: antigravityProfileSettings(auth),
  }).pipe(
    Effect.mapError(() =>
      authSupportError("The Antigravity profile settings could not be written."),
    ),
  );
  return { profile, platform, realProfileDirectory, realAcpDirectory };
});

export const prepareAntigravityProfile = Effect.fn("prepareAntigravityProfile")(function* (input: {
  readonly profileDirectory: string;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly runtimeExecutablePath?: string;
  readonly platform?: NodeJS.Platform;
  readonly auth?: AntigravityAuthConfig;
  readonly userHome?: string;
  readonly tempDirectory?: string;
}) {
  const { profile, platform } = yield* prepareAntigravityProfileBase(input);
  const userHome =
    input.userHome ??
    resolveAntigravityUserHome(
      platform,
      input.baseEnv ?? process.env,
      yield* HostProcess.HomeDirectory,
    );
  yield* linkAntigravityUserConfig({
    profileDirectory: profile.geminiHome,
    userHome,
    platform,
  });
  yield* linkAntigravityUserPlugins({
    profileDirectory: profile.geminiHome,
    userHome,
    platform,
  });
  if (platform === "win32") {
    yield* copyAntigravityUserConfigFiles({ profileDirectory: profile.geminiHome, userHome });
  }
  return profile;
});

const HELPER_SHARED_AUTH_FILES = [
  "antigravity-oauth-token",
  "acp_token.json",
  "installation_id",
] as const;

/**
 * Auth-only helper profile with an empty `config/` directory and a real, isolated
 * `antigravity-acp/` directory containing only links/copies of the profile's auth files so
 * title generation and model refresh never connect to user MCPs/hooks or delete `plugin_data/`.
 */
export const prepareAntigravityHelperProfile = Effect.fn("prepareAntigravityHelperProfile")(
  function* (input: {
    readonly profileDirectory: string;
    readonly baseEnv?: NodeJS.ProcessEnv;
    readonly runtimeExecutablePath?: string;
    readonly platform?: NodeJS.Platform;
    readonly auth?: AntigravityAuthConfig;
    readonly tempDirectory?: string;
  }) {
    const auth = input.auth ?? ANTIGRAVITY_PERSONAL_AUTH;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const helperDirectory = resolveAntigravityHelperProfileDirectory(path, input.profileDirectory);
    const { profile, platform, realAcpDirectory } = yield* prepareAntigravityProfileBase({
      ...input,
      geminiHome: helperDirectory,
    });
    const helperConfigDirectory = path.join(helperDirectory, "config");
    const helperAcpDirectory = profile.acpDirectory;

    // Migrate any earlier directory symlink to a real directory so helper runs never touch real plugin_data/ or mcp/.
    const existingAcpStat = yield* lstatOrUndefined(helperAcpDirectory);
    if (existingAcpStat?.isSymbolicLink()) {
      yield* fs
        .remove(helperAcpDirectory)
        .pipe(
          Effect.mapError(() =>
            authSupportError("The legacy Antigravity helper auth link could not be replaced."),
          ),
        );
    }

    for (const directory of [helperDirectory, helperConfigDirectory, helperAcpDirectory]) {
      yield* fs
        .makeDirectory(directory, { recursive: true, mode: 0o700 })
        .pipe(
          Effect.mapError(() =>
            authSupportError("The Antigravity helper profile directory could not be created."),
          ),
        );
      if (platform !== "win32") {
        yield* fs
          .chmod(directory, 0o700)
          .pipe(
            Effect.mapError(() =>
              authSupportError(
                "The Antigravity helper profile directory permissions could not be set.",
              ),
            ),
          );
      }
    }

    yield* writeFileStringAtomically({
      filePath: path.join(helperAcpDirectory, "settings.json"),
      contents: antigravityProfileSettings(auth),
    }).pipe(
      Effect.mapError(() =>
        authSupportError("The Antigravity helper profile settings could not be written."),
      ),
    );

    for (const fileName of HELPER_SHARED_AUTH_FILES) {
      const sourcePath = path.join(realAcpDirectory, fileName);
      const targetPath = path.join(helperAcpDirectory, fileName);
      const sourceExists = yield* fs.exists(sourcePath).pipe(Effect.orElseSucceed(() => false));
      const targetStat = yield* lstatOrUndefined(targetPath);
      if (!sourceExists) {
        if (targetStat !== undefined) {
          yield* fs
            .remove(targetPath, { force: true })
            .pipe(
              Effect.mapError(() =>
                authSupportError("Stale Antigravity helper auth file could not be removed."),
              ),
            );
        }
        continue;
      }
      if (platform === "win32") {
        yield* fs
          .copyFile(sourcePath, targetPath)
          .pipe(
            Effect.mapError(() =>
              authSupportError("The Antigravity helper auth file could not be copied."),
            ),
          );
      } else {
        const existingLink = targetStat?.isSymbolicLink()
          ? yield* fs.readLink(targetPath).pipe(
              Effect.map((value) => path.resolve(path.dirname(targetPath), value)),
              Effect.orElseSucceed((): string | undefined => undefined),
            )
          : undefined;
        if (existingLink !== sourcePath) {
          if (targetStat !== undefined) {
            yield* fs
              .remove(targetPath, { force: true })
              .pipe(
                Effect.mapError(() =>
                  authSupportError("The Antigravity helper auth file could not be replaced."),
                ),
              );
          }
          yield* Effect.tryPromise({
            try: () => NodeFSP.symlink(sourcePath, targetPath, "file"),
            catch: () => authSupportError("The Antigravity helper auth file could not be linked."),
          });
        }
      }
    }

    return profile;
  },
);

export function buildAntigravityAcpSpawnInput(input: {
  readonly installation: { readonly executablePath: string };
  readonly profile: AntigravityProfile;
  readonly cwd: string;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly auth?: AntigravityAuthConfig;
  readonly runtimeTempDirectory?: string;
}): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: input.installation.executablePath,
    args: [
      "acp",
      "--gemini-dir",
      input.profile.geminiHome,
      "--app-data-dir",
      // The CLI joins this beneath gemini-dir, including when the value is absolute.
      "antigravity-acp",
    ],
    cwd: input.cwd,
    env: antigravityEnvironment(
      input.profile,
      input.baseEnv ?? process.env,
      input.auth ?? ANTIGRAVITY_PERSONAL_AUTH,
      input.runtimeTempDirectory,
    ),
    extendEnv: false,
  };
}

/** Where `agy acp --login` sends Google; the page shows a code the user pastes back. */
const ANTIGRAVITY_CODE_REDIRECT_URI = "https://antigravity.google/oauth-callback";

export const parseAntigravityAuthorizationUrl = Effect.fn("parseAntigravityAuthorizationUrl")(
  function* (
    authorizationUrl: string,
    kind: "loopback" | "code" = "loopback",
  ): Effect.fn.Return<AntigravityAuthorizationUrl, AcpErrors.AcpError> {
    const invalidUrl = () =>
      authSupportError("Antigravity returned an invalid Google sign-in URL.");
    if (authorizationUrl.length > maxAuthorizationUrlLength || /\s/.test(authorizationUrl)) {
      return yield* invalidUrl();
    }
    const url = yield* decodeUrl(authorizationUrl).pipe(Effect.mapError(invalidUrl));
    const state = url.searchParams.get("state");
    const redirectUri = url.searchParams.get("redirect_uri");
    if (
      url.origin !== "https://accounts.google.com" ||
      url.pathname !== (kind === "loopback" ? "/o/oauth2/v2/auth" : "/o/oauth2/auth") ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      url.searchParams.getAll("state").length !== 1 ||
      url.searchParams.getAll("redirect_uri").length !== 1 ||
      url.searchParams.getAll("response_type").length !== 1 ||
      url.searchParams.get("response_type") !== "code" ||
      state === null ||
      state.length === 0 ||
      state.length > 512 ||
      /\s/.test(state) ||
      redirectUri === null ||
      (kind === "loopback"
        ? !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/.test(redirectUri)
        : redirectUri !== ANTIGRAVITY_CODE_REDIRECT_URI)
    ) {
      return yield* invalidUrl();
    }
    if (kind === "code") return { authorizationUrl, redirectUri, state };
    const redirect = yield* decodeUrl(redirectUri).pipe(Effect.mapError(invalidUrl));
    if (Number(redirect.port) < 1_024) return yield* invalidUrl();
    return { authorizationUrl, redirectUri, state };
  },
);

/**
 * What `agy acp --login` reads after its link: the code the Antigravity page shows, or that page's
 * URL, which must answer this sign-in. Undefined for anything else, including any line break.
 */
export function antigravityLoginResponse(
  pending: AntigravityAuthorizationUrl,
  response: string,
): string | undefined {
  const value = response.trim();
  if (/^[\w./~-]{1,2048}$/.test(value)) return value;
  if (value.length > maxAuthorizationUrlLength || /\s/.test(value)) return undefined;
  const url = URL.parse(value);
  if (
    url === null ||
    `${url.origin}${url.pathname}` !== pending.redirectUri ||
    url.username !== "" ||
    url.password !== "" ||
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.get("state") !== pending.state ||
    url.searchParams.getAll("code").length !== 1 ||
    !url.searchParams.get("code")
  ) {
    return undefined;
  }
  return value;
}

export function makeAntigravityStdoutTransform(
  input: {
    readonly onAuthorizationUrl?: (
      authorizationUrl: string,
    ) => Effect.Effect<void, AcpErrors.AcpError>;
  } = {},
) {
  const handleLine = Effect.fn("antigravityAuthSupport.handleStdoutLine")(function* (
    line: Uint8Array,
  ) {
    if (!authPrefixBytes.every((byte, index) => line[index] === byte)) return [line];
    const message = new TextDecoder().decode(line).replace(/\r?\n$/, "");
    const request = yield* parseAntigravityAuthorizationUrl(
      message.slice(ANTIGRAVITY_AUTH_STDOUT_PREFIX.length),
    );
    if (!input.onAuthorizationUrl) {
      return yield* authSupportError(ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE);
    }
    yield* input.onAuthorizationUrl(request.authorizationUrl);
    return [];
  });

  return (
    stdout: ChildProcessSpawner.ChildProcessHandle["stdout"],
  ): Stream.Stream<Uint8Array, PlatformError.PlatformError | AcpErrors.AcpError> =>
    Stream.suspend(() => {
      let pending: Uint8Array[] = [];
      let pendingBytes = 0;
      const finishLine = () => {
        const line = Buffer.concat(pending, pendingBytes);
        pending = [];
        pendingBytes = 0;
        return line;
      };
      return stdout.pipe(
        Stream.mapEffect(
          Effect.fn("antigravityAuthSupport.splitStdoutLines")(function* (chunk: Uint8Array) {
            const lines: Uint8Array[] = [];
            let offset = 0;
            while (offset < chunk.byteLength) {
              const newline = chunk.indexOf(10, offset);
              const end = newline === -1 ? chunk.byteLength : newline + 1;
              const part = chunk.subarray(offset, end);
              if (pendingBytes + part.byteLength > maxStdoutLineBytes) {
                return yield* authSupportError(
                  "Antigravity sent a protocol line that is too large.",
                );
              }
              pending.push(part);
              pendingBytes += part.byteLength;
              if (newline !== -1) lines.push(finishLine());
              offset = end;
            }
            return lines;
          }),
        ),
        Stream.flatMap(Stream.fromIterable),
        Stream.concat(
          Stream.suspend(() => (pendingBytes > 0 ? Stream.succeed(finishLine()) : Stream.empty)),
        ),
        Stream.mapEffect(handleLine),
        Stream.flatMap(Stream.fromIterable),
      );
    });
}

export function makeAntigravityStderrHandler(
  input: {
    readonly onAuthorizationUrl?: (
      authorizationUrl: string,
    ) => Effect.Effect<void, AcpErrors.AcpError>;
  } = {},
) {
  let pending = "";
  const seenExternalAuthUrls = new Set<string>();
  const logExternalBrowserUrl = Effect.fn("antigravityAuthSupport.logExternalBrowserUrl")(
    function* (rawUrl: string) {
      const parsed = URL.parse(rawUrl);
      if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
        return;
      }
      const sanitized = `${parsed.origin}${parsed.pathname}`;
      if (seenExternalAuthUrls.has(sanitized)) return;
      if (seenExternalAuthUrls.size < 32) seenExternalAuthUrls.add(sanitized);
      yield* Effect.logWarning(
        "Antigravity tried to open an external sign-in URL; authenticate plugins via 'agy /plugin' or the Antigravity app.",
        { url: sanitized },
      );
    },
  );
  // Untraced: this runs for every stderr line.
  const handleLine = Effect.fnUntraced(function* (line: string) {
    const message = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (message.length > maxBrowserHelperLineLength) return;
    const isBrowserHelperLine = message.startsWith(ANTIGRAVITY_AUTH_BROWSER_MARKER);
    const url = message.startsWith(ANTIGRAVITY_AUTH_STDOUT_PREFIX)
      ? Effect.succeed(message.slice(ANTIGRAVITY_AUTH_STDOUT_PREFIX.length))
      : isBrowserHelperLine
        ? decodeBrowserHelperUrl(message.slice(ANTIGRAVITY_AUTH_BROWSER_MARKER.length))
        : undefined;
    if (url === undefined) return;
    const rawUrl = yield* url.pipe(Effect.orElseSucceed((): string | undefined => undefined));
    if (rawUrl === undefined) return;
    yield* parseAntigravityAuthorizationUrl(rawUrl).pipe(
      Effect.matchEffect({
        onFailure: () => (isBrowserHelperLine ? logExternalBrowserUrl(rawUrl) : Effect.void),
        onSuccess: (request) =>
          input.onAuthorizationUrl
            ? input.onAuthorizationUrl(request.authorizationUrl)
            : Effect.fail(authSupportError(ANTIGRAVITY_SIGN_IN_REQUIRED_MESSAGE)),
      }),
    );
  });

  return Effect.fn("antigravityAuthSupport.handleStderr")(function* (text: string) {
    const lines = `${pending}${text}`.split("\n");
    pending = lines.pop() ?? "";
    if (pending.length > maxBrowserHelperLineLength) pending = "";
    yield* Effect.forEach(lines, handleLine, { discard: true });
  });
}
