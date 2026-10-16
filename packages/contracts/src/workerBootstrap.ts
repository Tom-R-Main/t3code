import * as Schema from "effect/Schema";

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/));
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536));
const Path = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const StaticProjection = {
  modelSha256: Digest,
  permissionsSha256: Digest,
  registrySha256: Digest,
  instructionsSha256: Digest,
  executionSha256: Digest,
};
const Runtime = Schema.Struct({
  cwd: Path,
  codexHome: Path,
  sqliteHome: Path,
  codexSelfExe: Path,
  codexLinuxSandboxExe: Schema.NullOr(Path),
  mainExecveWrapperExe: Schema.NullOr(Path),
  zshPath: Schema.NullOr(Path),
});
// This private wire is never a public provider setting, event or start input.
// Authorization is ephemeral: callers must not persist the request or decoder errors.
export const WorkerBootstrapMaterialization = Schema.Struct({
  version: Schema.Literal(1),
  template: Schema.Struct({
    version: Schema.Literal(1),
    upstreamRevision: Schema.Literal("36650394c5b38c2990ccf2a3457165ca3e9d9726"),
    buildRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
    template: Text,
    templateSha256: Digest,
    baseConfigurationSha256: Digest,
    bindingSha256: Digest,
    model: Text,
    modelProviderId: Identifier,
    modelProviderSha256: Digest,
    server: Identifier,
    namespace: Identifier,
    tool: Identifier,
    runtime: Runtime,
    staticProjection: Schema.Struct(StaticProjection),
    mcp: Schema.Struct({
      enterpriseManagedAuth: Schema.Null,
      oauthStoreMode: Schema.Literals(["auto", "file", "keyring"]),
      oauthCallbackPort: Schema.Null,
      oauthCallbackUrl: Schema.Null,
      nonPrefixedServers: Schema.Null,
      optionalStartupGraceNanos: Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]{0,11})$/)),
    }),
  }),
  input: Schema.Struct({
    endpoint: Text,
    authorization: Schema.String.check(Schema.isPattern(/^Bearer [A-Za-z0-9_-]{43}$/)),
    bindingSha256: Digest,
    launchId: Identifier,
    incarnationId: Identifier,
    model: Text,
    baseConfiguration: Text,
  }),
  runtime: Runtime,
  serverConfig: Schema.Struct({
    url: Text,
    http_headers: Schema.Struct({ Authorization: Text }),
    environment_id: Schema.Literal("local"),
    enabled: Schema.Literal(true),
    tool_timeout_sec: Schema.Null,
    enabled_tools: Schema.Tuple([Schema.Literal("execute")]),
  }),
  projection: Schema.Struct({
    domain: Schema.Literal("codex-worker-loaded-config"),
    schemaVersion: Schema.Literal("sift-worker-effective-config-v1"),
    ...StaticProjection,
    mcpSha256: Digest,
  }),
  configSha256: Digest,
  serverConfigSha256: Digest,
  requestSha256: Digest,
});
