import {
  ClaudeSettings,
  CodexSettings,
  type ProviderInstanceConfig,
  type SessionImportSource,
} from "@ryco/contracts";
import { Effect, Schema } from "effect";
import {
  mergeProviderInstanceEnvironment,
  normalizeProviderHomeEnvironment,
} from "./ProviderInstanceEnvironment.ts";
import { resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";
import { makeClaudeEnvironment, resolveClaudeSourceRoot } from "./Drivers/ClaudeHome.ts";

// Runtime and archive discovery must resolve the same configured store. In
// particular a Codex auth overlay owns credentials, never a second history.
export const resolveProviderSourceLayout = Effect.fn("resolveProviderSourceLayout")(function* (
  source: SessionImportSource,
  instance?: ProviderInstanceConfig,
) {
  const environment = normalizeProviderHomeEnvironment(
    mergeProviderInstanceEnvironment(instance?.environment),
  );
  if (source === "codex") {
    const config = yield* Schema.decodeUnknownEffect(CodexSettings)(instance?.config ?? {});
    const codex = yield* resolveCodexHomeLayout(config, environment);
    return {
      root: codex.sharedHomePath,
      environment,
      codex,
      binaryPath: config.binaryPath,
      enabled: instance?.enabled ?? config.enabled,
    };
  }
  const config = yield* Schema.decodeUnknownEffect(ClaudeSettings)(instance?.config ?? {});
  return {
    root: yield* resolveClaudeSourceRoot(config, environment),
    environment: yield* makeClaudeEnvironment(config, environment),
    codex: undefined,
    binaryPath: config.binaryPath,
    enabled: instance?.enabled ?? config.enabled,
  };
});
