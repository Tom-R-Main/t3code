import type { McpToolExposureMode } from "@t3tools/provider-core/server/mcpSession";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export const TOOL_SEARCH = "tool_search";
export const TOOL_CALL = "tool_call";
const MAX_PROXY_SCHEMA_BYTES = 8_000;

/** What a deferring client lists before it searches. Pi's extension declares the same three. */
const DIRECT_TOOLS: ReadonlySet<string> = new Set([
  "orchestrator_capabilities",
  "delegate_task",
  "task_status",
  TOOL_SEARCH,
]);

/** Fixed tool surface for runtimes that ignore `notifications/tools/list_changed`. */
const PROXY_DIRECT_TOOLS: ReadonlySet<string> = new Set([
  "orchestrator_capabilities",
  "delegate_task",
  "task_status",
  TOOL_SEARCH,
  TOOL_CALL,
]);

const MAX_RESULTS = 10;
// Sessions that ended are never reported here, so keep only the newest.
const MAX_SESSIONS = 256;

export interface ListedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: unknown;
}

export class McpToolExposure extends Context.Service<
  McpToolExposure,
  {
    /** Finds tools for the query; expands listing in deferred mode or returns bounded schemas in proxy mode. */
    readonly search: (
      providerSessionId: string,
      query: string,
      options?: { readonly mode?: McpToolExposureMode | undefined },
    ) => Effect.Effect<ReadonlyArray<ListedTool>>;
    readonly isListed: (
      providerSessionId: string,
      tool: string,
      mode?: McpToolExposureMode | undefined,
    ) => boolean;
  }
>()("t3/mcp/McpToolExposure") {}

const score = (tool: ListedTool, terms: ReadonlyArray<string>) => {
  const name = tool.name.toLowerCase();
  const description = tool.description.toLowerCase();
  let total = 0;
  for (const term of terms) {
    if (term === name) total += 100;
    else if (name.includes(term)) total += 3;
    else if (description.includes(term)) total += 1;
  }
  return total;
};

const attachBoundedProxySchemas = (found: ReadonlyArray<ListedTool>): ReadonlyArray<ListedTool> => {
  const result: Array<ListedTool> = found.map(({ name, description }) => ({ name, description }));
  for (let index = 0; index < found.length; index++) {
    const schema = found[index]?.inputSchema;
    if (schema === undefined) continue;
    const candidate = result.map((entry, i) =>
      i === index ? { ...entry, inputSchema: schema } : entry,
    );
    if (Buffer.byteLength(JSON.stringify({ tools: candidate }), "utf8") <= MAX_PROXY_SCHEMA_BYTES) {
      result[index] = candidate[index]!;
    }
  }
  return result;
};

export const make = (
  tools: () => ReadonlyArray<ListedTool>,
  announceListChanged: () => Effect.Effect<void>,
) => {
  const loaded = new Map<string, Set<string>>();
  const load = (providerSessionId: string, names: ReadonlyArray<string>) => {
    const listed = loaded.get(providerSessionId) ?? new Set<string>();
    loaded.delete(providerSessionId);
    loaded.set(providerSessionId, listed);
    for (const name of names) listed.add(name);
    for (const oldest of loaded.keys()) {
      if (loaded.size <= MAX_SESSIONS) break;
      loaded.delete(oldest);
    }
  };
  return McpToolExposure.of({
    search: Effect.fn("McpToolExposure.search")(function* (providerSessionId, query, options) {
      const terms = query
        .toLowerCase()
        .split(/[^a-z0-9_]+/u)
        .filter(Boolean);
      const found = tools()
        .filter((tool) => tool.name !== TOOL_SEARCH && tool.name !== TOOL_CALL)
        .map((tool) => ({ tool, score: score(tool, terms) }))
        .filter((match) => match.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_RESULTS)
        .map((match) => match.tool);
      if (options?.mode === "deferred-proxy") {
        return attachBoundedProxySchemas(found);
      }
      if (found.length > 0) {
        load(
          providerSessionId,
          found.map((tool) => tool.name),
        );
        yield* announceListChanged();
      }
      return found.map(({ name, description }) => ({ name, description }));
    }),
    isListed: (providerSessionId, tool, mode = "deferred") => {
      if (mode === "deferred-proxy") {
        return PROXY_DIRECT_TOOLS.has(tool);
      }
      if (mode === "full") {
        return tool !== TOOL_SEARCH && tool !== TOOL_CALL;
      }
      return (
        tool !== TOOL_CALL &&
        (DIRECT_TOOLS.has(tool) || loaded.get(providerSessionId)?.has(tool) === true)
      );
    },
  });
};
