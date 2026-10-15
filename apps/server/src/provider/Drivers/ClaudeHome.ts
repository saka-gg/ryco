import type { ClaudeSettings } from "@ryco/contracts";
import { Effect, Path } from "effect";

import { normalizeProviderHomeEnvironment } from "../ProviderInstanceEnvironment.ts";
import { parseProviderSourcePaths } from "../ProviderSourcePaths.ts";

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<string, never, Path.Path> {
  yield* Path.Path;
  return parseProviderSourcePaths("claudeAgent", config, baseEnv).home;
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  yield* Path.Path;
  const resolvedHomePath = yield* resolveClaudeHomePath(
    config,
    normalizeProviderHomeEnvironment(baseEnv),
  );
  const configuredDir = baseEnv.CLAUDE_CONFIG_DIR;
  const resolvedDir = configuredDir?.trim()
    ? parseProviderSourcePaths("claudeAgent", config, baseEnv).root
    : configuredDir === undefined
      ? undefined
      : "";
  const homeChanged =
    config.homePath.trim().length > 0 ||
    (baseEnv.HOME !== undefined && baseEnv.HOME !== resolvedHomePath);
  const dirChanged = resolvedDir !== configuredDir;
  if (!homeChanged && !dirChanged) return baseEnv;
  return {
    ...baseEnv,
    ...(homeChanged ? { HOME: resolvedHomePath } : {}),
    ...(dirChanged ? { CLAUDE_CONFIG_DIR: resolvedDir } : {}),
  };
});

// This is the SDK's configuration store, not an arbitrary HOME scan.
export const resolveClaudeSourceRoot = Effect.fn("resolveClaudeSourceRoot")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  yield* Path.Path;
  const env = yield* makeClaudeEnvironment(config, baseEnv);
  return parseProviderSourcePaths("claudeAgent", config, env).root;
});

/**
 * Files in the Claude configuration store whose replacement changes what a status probe reports:
 * the credential file (login/logout) and `settings.json` (an `apiKeyHelper` or auth `env` switch).
 * Stat'ed into the probe fingerprint so an adopted snapshot never outlives an auth change.
 */
export const resolveClaudeProbeAuthFiles = Effect.fn("resolveClaudeProbeAuthFiles")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  const path = yield* Path.Path;
  const root = yield* resolveClaudeSourceRoot(config, baseEnv);
  return [path.join(root, ".credentials.json"), path.join(root, "settings.json")] as const;
});

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (config: Pick<ClaudeSettings, "homePath">, baseEnv: NodeJS.ProcessEnv = process.env) {
    if (baseEnv.CLAUDE_CONFIG_DIR?.trim())
      return `claude:store:${yield* resolveClaudeSourceRoot(config, baseEnv)}`;
    return `claude:home:${yield* resolveClaudeHomePath(config, baseEnv)}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
    baseEnv: NodeJS.ProcessEnv = process.env,
  ) {
    const key = baseEnv.CLAUDE_CONFIG_DIR?.trim()
      ? yield* resolveClaudeSourceRoot(config, baseEnv)
      : yield* resolveClaudeHomePath(config, baseEnv);
    return `${config.binaryPath}\0${key}`;
  },
);
