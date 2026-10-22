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
import { resolveCodexInstanceLayout } from "./Drivers/CodexHomeLayout.ts";
import { makeClaudeEnvironment, resolveClaudeSourceRoot } from "./Drivers/ClaudeHome.ts";

// Runtime and archive discovery must resolve the same configured store. In
// particular a Codex auth overlay owns credentials, never a second history.
export const resolveProviderSourceLayout = Effect.fn("resolveProviderSourceLayout")(function* (
  source: SessionImportSource,
  instance?: ProviderInstanceConfig,
) {
  if (source === "codex") {
    const config = yield* Schema.decodeUnknownEffect(CodexSettings)(instance?.config ?? {});
    const { environment, layout: codex } = yield* resolveCodexInstanceLayout(
      config,
      instance?.environment,
    );
    return {
      root: codex.sharedHomePath,
      environment,
      codex,
      binaryPath: config.binaryPath,
      enabled: instance?.enabled ?? config.enabled,
    };
  }
  const environment = normalizeProviderHomeEnvironment(
    mergeProviderInstanceEnvironment(instance?.environment),
  );
  const config = yield* Schema.decodeUnknownEffect(ClaudeSettings)(instance?.config ?? {});
  return {
    root: yield* resolveClaudeSourceRoot(config, environment),
    environment: yield* makeClaudeEnvironment(config, environment),
    codex: undefined,
    binaryPath: config.binaryPath,
    enabled: instance?.enabled ?? config.enabled,
  };
});
