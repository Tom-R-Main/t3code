import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

import { expandHomePath } from "../pathExpansion.ts";

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    // A restricted worker's immutable launcher policy cannot be replaced or
    // disabled by mutable provider settings (including an empty-string value).
    if ((baseEnv.CODEX_RESTRICTED_WORKER === "1" || baseEnv.CODEX_WORKER_POLICY_V1 !== undefined) &&
      (variable.name === "CODEX_RESTRICTED_WORKER" || variable.name === "CODEX_WORKER_POLICY_V1")) continue;
    // Child processes do not apply shell expansion to environment values.
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value)
        : variable.value;
  }
  return next;
}
