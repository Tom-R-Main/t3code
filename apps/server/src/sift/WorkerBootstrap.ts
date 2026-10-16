// @effect-diagnostics nodeBuiltinImport:off
import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { WorkerBootstrapMaterialization } from "../../../../packages/contracts/src/workerBootstrap.ts";
import { readWorkerPolicyLaunch } from "./WorkerPolicy.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const unavailable = () => new WorkerBootstrapError({ message: "Restricted worker bootstrap unavailable." });
class WorkerBootstrapError extends Schema.TaggedError<WorkerBootstrapError>()("WorkerBootstrapError", {
  message: Schema.String,
}) {}

// The composer and native loader hash this same closed JSON subset. Never use
// locale sorting or lossy UTF-8 replacement to establish an identity.
export function canonicalWorkerBootstrap(value: unknown): string {
  if (typeof value === "string") {
    if (Array.from(value).some((character) => {
      const point = character.codePointAt(0)!;
      return point >= 0xd800 && point <= 0xdfff;
    })) throw unavailable();
    return encodeJson(value);
  }
  if (value === null || typeof value === "boolean" || value === 1) return encodeJson(value);
  if (Array.isArray(value)) return `[${value.map(canonicalWorkerBootstrap).join(",")}]`;
  if (Schema.is(Schema.Record(Schema.String, Schema.Unknown))(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${encodeJson(key)}:${canonicalWorkerBootstrap(value[key])}`).join(",")}}`;
  }
  throw unavailable();
}
const canonicalPath = (value: string) => value.startsWith("/") && !/[\\\u0000-\u001f\u007f]/.test(value) &&
  NodeBuffer.Buffer.byteLength(value) <= 4096 &&
  (value === "/" || value.slice(1).split("/").every((part) => part !== "" && part !== "." && part !== ".."));

interface Target {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly cwd: string;
  readonly model: string;
}
interface RuntimeTarget extends Target {
  readonly binaryPath: string;
  readonly homePath: string | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly launchArgs: string | undefined;
  readonly appServerArgs: ReadonlyArray<string> | undefined;
  readonly hasResumeCursor: boolean;
}
interface BootstrapCapability {
  readonly assertTarget: (target: Target, environment: NodeJS.ProcessEnv) => Effect.Effect<void, WorkerBootstrapError>;
  readonly consume: (target: RuntimeTarget) => Effect.Effect<Uint8Array, WorkerBootstrapError>;
}
// Only the authenticated private bridge provides this service. No serializable
// provider input or settings field can construct it. Its value contains closures,
// not the secret-bearing request, so an Effect error cannot render that request.
export class WorkerBootstrap extends Context.Service<WorkerBootstrap, BootstrapCapability>()("sift/WorkerBootstrap") {}

export const ensureWorkerBootstrapJournal = (sql: SqlClient.SqlClient) => sql`CREATE TABLE IF NOT EXISTS sift_worker_consumed_launches (
  launch_id TEXT NOT NULL UNIQUE, incarnation_id TEXT NOT NULL UNIQUE,
  binding_sha256 TEXT NOT NULL, thread_id TEXT NOT NULL, consumed_at TEXT NOT NULL
)`;

export const burnWorkerBootstrap = (sql: SqlClient.SqlClient, identity: {
  readonly launchId: string; readonly incarnationId: string; readonly bindingSha256: string;
  readonly threadId: ThreadId; readonly consumedAt: string;
}) => sql`INSERT INTO sift_worker_consumed_launches
  (launch_id, incarnation_id, binding_sha256, thread_id, consumed_at)
  VALUES (${identity.launchId}, ${identity.incarnationId}, ${identity.bindingSha256}, ${identity.threadId}, ${identity.consumedAt})`;

export const prepareWorkerBootstrap = (
  materialization: typeof WorkerBootstrapMaterialization.Type,
  expectedTarget: Target,
  environment: NodeJS.ProcessEnv,
) => Effect.try({
  try: () => {
    const launch = readWorkerPolicyLaunch(environment);
    if (!launch) throw unavailable();
    const { requestSha256, ...body } = materialization;
    const { template, input, projection, serverConfig } = materialization;
    const runtime = Object.freeze({ ...materialization.runtime });
    const target = Object.freeze({ ...expectedTarget });
    const encoded = canonicalWorkerBootstrap({ version: 1, materialization });
    if (NodeBuffer.Buffer.byteLength(encoded) > 262_144 || digest(canonicalWorkerBootstrap(body)) !== requestSha256 ||
      canonicalWorkerBootstrap(runtime) !== canonicalWorkerBootstrap(template.runtime) ||
      Object.values(runtime).some((path) => path !== null && !canonicalPath(path)) ||
      input.launchId !== launch.launchId || input.incarnationId !== launch.incarnationId ||
      input.bindingSha256 !== launch.bindingSha256 || template.bindingSha256 !== launch.bindingSha256 ||
      input.endpoint !== launch.endpoint || serverConfig.url !== launch.endpoint ||
      !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/mcp$/.test(input.endpoint) || Number(new URL(input.endpoint).port) > 65535 ||
      input.authorization !== serverConfig.http_headers.Authorization ||
      input.model !== target.model || input.model !== launch.model || template.model !== launch.model ||
      runtime.cwd !== target.cwd || template.server !== launch.server || template.namespace !== launch.namespace ||
      template.tool !== launch.tool || launch.rawTool !== "execute" ||
      template.modelProviderId !== launch.modelProviderId || template.modelProviderSha256 !== launch.modelProviderSha256 ||
      digest(template.template) !== template.templateSha256 || digest(input.baseConfiguration) !== template.baseConfigurationSha256 ||
      digest(canonicalWorkerBootstrap(serverConfig)) !== materialization.serverConfigSha256 ||
      materialization.serverConfigSha256 !== launch.serverConfigSha256 ||
      digest(canonicalWorkerBootstrap(projection)) !== materialization.configSha256 ||
      launch.configSchemaVersion !== projection.schemaVersion || launch.configSha256 !== materialization.configSha256 ||
      canonicalWorkerBootstrap(template.staticProjection) !== canonicalWorkerBootstrap({
        modelSha256: projection.modelSha256, permissionsSha256: projection.permissionsSha256,
        registrySha256: projection.registrySha256, instructionsSha256: projection.instructionsSha256,
        executionSha256: projection.executionSha256,
      }) ||
      digest(canonicalWorkerBootstrap({ ...template.mcp, servers: { [template.server]: serverConfig } })) !== projection.mcpSha256 ||
      /\\|authorization|bearer|http_headers|env_key|api_key|gateway_oauth/i.test(template.template + input.baseConfiguration) ||
      (template.template + input.baseConfiguration).includes(input.authorization.slice("Bearer ".length))) throw unavailable();
    const launchIdentity = canonicalWorkerBootstrap(launch);
    let bytes: Uint8Array | undefined = NodeBuffer.Buffer.from(encoded);
    const matches = (candidate: Target, env: NodeJS.ProcessEnv) => {
      const current = readWorkerPolicyLaunch(env);
      return bytes !== undefined && current !== undefined && canonicalWorkerBootstrap(current) === launchIdentity &&
        candidate.threadId === target.threadId && candidate.providerInstanceId === target.providerInstanceId &&
        candidate.cwd === target.cwd && candidate.model === target.model;
    };
    const capability: BootstrapCapability = {
      assertTarget: (candidate, env) => Effect.try({ try: () => {
        if (!matches(candidate, env)) throw unavailable();
      }, catch: unavailable }),
      consume: (candidate) => Effect.try({ try: () => {
        if (!matches(candidate, candidate.environment) || candidate.binaryPath !== runtime.codexSelfExe ||
          (candidate.homePath ?? candidate.environment.CODEX_HOME) !== runtime.codexHome ||
          candidate.launchArgs?.trim() || candidate.appServerArgs?.length || candidate.hasResumeCursor) throw unavailable();
        if (!bytes) throw unavailable();
        const result = bytes;
        bytes = undefined;
        return result;
      }, catch: unavailable }),
    };
    return { launch, capability, dispose: () => { bytes?.fill(0); bytes = undefined; } };
  },
  // Decoder/callback details can contain the header; never retain their cause.
  catch: unavailable,
});
