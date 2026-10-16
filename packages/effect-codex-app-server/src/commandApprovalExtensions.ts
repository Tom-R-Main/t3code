import * as Schema from "effect/Schema";
import * as CodexSchema from "./_generated/schema.gen.ts";

// Keep the fork extension at the protocol boundary without editing generated
// upstream schemas. Unknown/malformed extensions still permit a one-time prompt;
// consumers must validate them before deriving reusable approval authority.
export const CommandApprovalParams = Schema.Struct({
  ...CodexSchema.CommandExecutionRequestApprovalParams.fields,
  siftCommandScope: Schema.optionalKey(Schema.Unknown),
});
export type CommandApprovalParams = typeof CommandApprovalParams.Type;
