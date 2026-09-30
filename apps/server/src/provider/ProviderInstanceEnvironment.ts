import { parseProviderSourcePaths } from "./ProviderSourcePaths.ts";
import type { ProviderInstanceEnvironment } from "@ryco/contracts";

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    next[variable.name] = variable.value;
  }
  return next;
}

// Resolve relative/tilde HOME declarations before starting a provider in a
// project cwd, so its archive location agrees with backend source discovery.
export function normalizeProviderHomeEnvironment(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (baseEnv.HOME === undefined) return baseEnv;
  const home = parseProviderSourcePaths("claudeAgent", {}, baseEnv).home;
  return home === baseEnv.HOME ? baseEnv : { ...baseEnv, HOME: home };
}
