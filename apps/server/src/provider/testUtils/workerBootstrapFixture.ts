// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { WorkerBootstrapMaterialization } from "../../../../../packages/contracts/src/workerBootstrap.ts";
import { canonicalWorkerBootstrap } from "../../sift/WorkerBootstrap.ts";

export const fixtureBootstrapDigest = (value: unknown) => NodeCrypto.createHash("sha256")
  .update(canonicalWorkerBootstrap(value)).digest("hex");

// Public fixed fixture bytes, never an actual credential or provider invocation.
export function workerBootstrapFixture(cwd = "/workspace", executable = "/opt/sift/codex") {
  const staticProjection = { modelSha256: "1".repeat(64), permissionsSha256: "2".repeat(64),
    registrySha256: "3".repeat(64), instructionsSha256: "4".repeat(64), executionSha256: "5".repeat(64) };
  const runtime = { cwd, codexHome: "/fixture-codex", sqliteHome: "/fixture-sqlite", codexSelfExe: executable,
    codexLinuxSandboxExe: null, mainExecveWrapperExe: null, zshPath: null };
  const mcp = { enterpriseManagedAuth: null, oauthStoreMode: "file", oauthCallbackPort: null,
    oauthCallbackUrl: null, nonPrefixedServers: null, optionalStartupGraceNanos: "0" };
  const input = { endpoint: "http://127.0.0.1:4321/mcp", authorization: `Bearer ${"f".repeat(43)}`,
    bindingSha256: "a".repeat(64), launchId: "fixture-launch", incarnationId: "fixture-incarnation",
    model: "fixture-model", baseConfiguration: 'model = "fixture-model"' };
  const template = { version: 1, upstreamRevision: "36650394c5b38c2990ccf2a3457165ca3e9d9726", buildRevision: "6".repeat(40),
    template: 'model = "fixture-model"', templateSha256: NodeCrypto.createHash("sha256").update(input.baseConfiguration).digest("hex"),
    baseConfigurationSha256: NodeCrypto.createHash("sha256").update(input.baseConfiguration).digest("hex"),
    bindingSha256: input.bindingSha256, model: input.model, modelProviderId: "fixture-provider",
    modelProviderSha256: "c".repeat(64), server: "executor", namespace: "sift", tool: "execute", runtime, staticProjection, mcp };
  const serverConfig = { url: input.endpoint, http_headers: { Authorization: input.authorization },
    environment_id: "local", enabled: true, tool_timeout_sec: null, enabled_tools: ["execute"] };
  const projection = { domain: "codex-worker-loaded-config", schemaVersion: "sift-worker-effective-config-v1",
    ...staticProjection, mcpSha256: fixtureBootstrapDigest({ ...mcp, servers: { executor: serverConfig } }) };
  const body = { version: 1, template, input, runtime, serverConfig, projection,
    configSha256: fixtureBootstrapDigest(projection), serverConfigSha256: fixtureBootstrapDigest(serverConfig) };
  const materialization = Schema.decodeUnknownSync(WorkerBootstrapMaterialization)({ ...body, requestSha256: fixtureBootstrapDigest(body) });
  const launch = { version: 1, launchId: input.launchId, incarnationId: input.incarnationId,
    bindingSha256: input.bindingSha256, executorProtocolVersion: "sift-worker-executor-v1", server: template.server,
    namespace: template.namespace, tool: template.tool, rawTool: "execute", endpoint: input.endpoint,
    serverConfigSha256: body.serverConfigSha256, model: input.model, modelProviderId: template.modelProviderId,
    modelProviderSha256: template.modelProviderSha256, configSchemaVersion: projection.schemaVersion, configSha256: body.configSha256 };
  return { materialization, launch, environment: { CODEX_RESTRICTED_WORKER: "1", CODEX_HOME: runtime.codexHome,
    CODEX_WORKER_POLICY_V1: Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(launch) },
    target: { threadId: ThreadId.make("bound-thread"), providerInstanceId: ProviderInstanceId.make("codex"), cwd, model: input.model } };
}
