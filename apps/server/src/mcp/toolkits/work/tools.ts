import {
  OrchestratorMcpFailure,
  ProjectWork,
  ProjectWorkMutation,
  ProjectWorkRead,
  ProjectWorkReadResult,
} from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as ProjectWorkService from "../../../projectWork/ProjectWorkService.ts";
import { ManagedProjectFolders } from "../../../project/ManagedProjectFolders.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const common = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectWorkService.ProjectWorkService,
  ],
};

const read = Tool.make("t3_work_read", {
  ...common,
  description:
    "Read durable work in this thread's project. With workId: full current requirements, accepted assignment and evidence; add version for historical state. Without: up to 100 summaries; pass nextCursor as after. Reload before resuming or changing work. References are stored text, never fetched.",
  parameters: ProjectWorkRead,
  success: ProjectWorkReadResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const mutate = Tool.make("t3_work", {
  ...common,
  dependencies: [...common.dependencies, ManagedProjectFolders],
  description:
    "Persist work in this thread's project. Retry a lost reply with identical requestId/input; receipt is the original result, not current state. create/revise stores full selected context and criteria. claim binds the exact packet to your active run; it does not launch an agent. Delegate with existing tools, then child claims. Mutations need expectedVersion. Only creator thread may revise/release/cancel/reopen; release fences the assignment but does not stop its agent. Stop/reconcile its run separately. Evidence is attributed agent reporting, not verified truth or independent review. complete needs passing evidence for every criterion at artifactRevision. Required human acceptance remains pending; agents cannot satisfy it. wait records a release condition. resume records resolution and binds a new run of the same thread; reattest evidence after rebinding. Neither schedules a wake.",
  parameters: ProjectWorkMutation,
  success: ProjectWork,
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const WorkToolkit = Toolkit.make(read, mutate);
