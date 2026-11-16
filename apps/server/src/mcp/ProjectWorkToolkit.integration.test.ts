import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProjectWork,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { ManagedProjectFolders } from "../project/ManagedProjectFolders.ts";
import * as ProjectWorkService from "../projectWork/ProjectWorkService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import { WorkToolkit } from "./toolkits/work/tools.ts";
import * as WorkHandlers from "./toolkits/work/handlers.ts";

const owner = ThreadId.make("thread:owner");
const foreign = ThreadId.make("thread:foreign");
const ended = ThreadId.make("thread:ended");
const linked = ThreadId.make("thread:linked");
const scratch = ThreadId.make("thread:scratch");
const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
  getThreadShell: (id) =>
    Effect.succeed({
      ...liveThreadShell(id, { activeRunId: id === ended ? null : RunId.make(`run:${id}`) }),
      projectId: ProjectId.make(
        id === foreign ? "project:foreign" : id === scratch ? "project:scratch" : "project:work",
      ),
      ...(id === linked
        ? { linkOrigin: { sessionId: "link", label: "peer", access: "approval-required" as const } }
        : {}),
    }),
});
const layer = McpHttpServer.toolkitRegistration(WorkToolkit, WorkHandlers.layer).pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(threads),
  Layer.provide(
    Layer.mock(ManagedProjectFolders)({
      isScratchProject: (id) => Effect.succeed(id === "project:scratch"),
    }),
  ),
  Layer.provide(ProjectWorkService.layer.pipe(Layer.provide(Sqlite.layerMemory))),
);
const scope = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:test"),
  requestNamespace: `session:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `session:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "work-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "work-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const outcome = Schema.fromJsonString(
  Schema.Union([ProjectWork, Schema.Struct({ code: Schema.String, message: Schema.String })]),
);
const call = (
  name: string,
  caller: McpInvocationContext.McpInvocationScope,
  args: Record<string, unknown>,
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.flatMap((result) =>
      Schema.decodeEffect(outcome)(
        result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
      ),
    ),
    Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
    Effect.provideService(McpSchema.McpServerClient, client),
  );
const packet = {
  objective: "Deliver the source ZIP",
  authorizedScope: "This project only",
  sources: [{ reference: "decision:1", attribution: "user", excerpt: "Z".repeat(8000) }],
  criteria: [{ id: "zip", description: "ZIP is delivered", requiredEvidence: ["runtime"] }],
  dependencies: [],
};
const create = { requestId: "create", operation: { action: "create", workId: "delivery", packet } };

it.effect(
  "binds project and run from authenticated MCP identity and preserves the selected context",
  () =>
    Effect.gen(function* () {
      const oversized = {
        requestId: "oversized",
        operation: {
          ...create.operation,
          packet: {
            ...packet,
            sources: [{ ...packet.sources[0], excerpt: "Z".repeat(8001) }],
          },
        },
      };
      assert.propertyVal(
        yield* Effect.flip(call("t3_work", scope(owner), oversized)),
        "_tag",
        "InvalidParams",
      );
      const created = yield* call("t3_work", scope(owner), create);
      assert.isFalse("code" in created);
      const child = ThreadId.make("thread:child");
      const accepted = yield* call("t3_work", scope(child), {
        requestId: "claim",
        operation: { action: "claim", workId: "delivery", expectedVersion: 1 },
      });
      if ("code" in accepted) return yield* Effect.die(accepted);
      assert.equal(accepted.assignment?.threadId, child);
      assert.equal(accepted.assignment?.runId, `run:${child}`);
      assert.deepEqual(accepted.assignment?.packet.sources, packet.sources);
      const otherProject = yield* call("t3_work_read", scope(foreign), { workId: "delivery" });
      assert.isTrue("code" in otherProject);
      const restored = yield* call("t3_work_read", scope(child), {
        workId: "delivery",
        version: 1,
      });
      if ("code" in restored) return yield* Effect.die(restored);
      assert.equal(restored.assignment, null);
      assert.deepEqual(restored.packet.sources, packet.sources);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "refuses outside, inactive, scratch, stale-provider, missing-capability and fenced-link writes",
  () =>
    Effect.gen(function* () {
      const outside: McpInvocationContext.McpInvocationScope = {
        ...scope(owner),
        thread: undefined,
        client: { sessionId: "external", label: "external", access: "full-access" },
      };
      const staleProvider = {
        ...scope(owner),
        thread: {
          ...scope(owner).thread!,
          providerInstanceId: ProviderInstanceId.make("old-provider"),
        },
      };
      const noCapability = { ...scope(owner), capabilities: new Set<"orchestration">() };
      assert.propertyVal(
        yield* Effect.flip(call("t3_work", outside, create)),
        "_tag",
        "InvalidParams",
      );
      for (const caller of [
        scope(ended),
        scope(scratch),
        staleProvider,
        noCapability,
        scope(linked),
      ]) {
        const refused = yield* call("t3_work", caller, create);
        assert.isTrue("code" in refused);
      }
      const accepted = yield* call("t3_work", scope(owner), create);
      assert.isFalse("code" in accepted);
    }).pipe(Effect.provide(layer)),
);
