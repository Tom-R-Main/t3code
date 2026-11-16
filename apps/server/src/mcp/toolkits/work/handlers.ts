import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ProjectWorkService from "../../../projectWork/ProjectWorkService.ts";
import { ManagedProjectFolders } from "../../../project/ManagedProjectFolders.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { assertLiveCaller, readCaller } from "../../threadAccess.ts";
import { assertNotLinked } from "../../linkOrigin.ts";
import { WorkToolkit } from "./tools.ts";

const failure = (
  error: ProjectWorkService.ProjectWorkError | ProjectWorkService.ProjectWorkStorageError,
) =>
  new OrchestratorMcpFailure({
    code: error._tag === "ProjectWorkError" ? "invalid_request" : "orchestration_error",
    message: error.message,
  });

const caller = Effect.fn("mcp.projectWorkCaller")(function* () {
  const context = yield* readCaller();
  if (context.caller === undefined || context.scope.thread === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "target_required",
      message: "Project work requires a T3 thread caller.",
    });
  }
  return { ...context, caller: context.caller, thread: context.scope.thread };
});

export const layer = McpToolAccess.toLayer(WorkToolkit, {
  t3_work_read: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const context = yield* caller();
      const work = yield* ProjectWorkService.ProjectWorkService;
      return yield* work.read(context.caller.projectId, input).pipe(Effect.mapError(failure));
    }),
  ),
  t3_work: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const context = yield* caller();
      yield* assertLiveCaller(context);
      yield* assertNotLinked(context, "change project work");
      if (context.caller.activeRunId === null) {
        return yield* new OrchestratorMcpFailure({
          code: "parent_not_active",
          message: "Project work changes require an active T3 run.",
        });
      }
      if (
        input.operation.action === "create" &&
        (yield* (yield* ManagedProjectFolders).isScratchProject(context.caller.projectId))
      ) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            'Durable work requires a project. Ask the user to promote this "No project" thread before creating work.',
        });
      }
      const work = yield* ProjectWorkService.ProjectWorkService;
      return yield* work
        .mutate(
          {
            projectId: context.caller.projectId,
            threadId: context.caller.id,
            runId: context.caller.activeRunId,
            providerSessionId: context.thread.providerSessionId,
          },
          input,
        )
        .pipe(Effect.mapError(failure));
    }),
  ),
});
