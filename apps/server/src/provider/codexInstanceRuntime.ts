/**
 * What a Codex provider instance's driver starts Codex with, resolved from the settings for owner
 * actions that run their own Codex process (reset credits, sign-in), so they act on exactly the
 * instance's binary, homes and environment.
 *
 * @module codexInstanceRuntime
 */
import { CodexSettings, type ProviderInstanceId, type ServerSettings } from "@ryco/contracts";
import { Cause, Effect, type Path, Schema } from "effect";

import { type CodexHomeLayout, resolveCodexInstanceLayout } from "./Drivers/CodexHomeLayout.ts";
import { providerInstanceConfigFor, resolveInstanceEnabled } from "./providerInstanceConfig.ts";

export interface CodexInstanceRuntime {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly layout: CodexHomeLayout;
  /** The instance's environment, before `codexProcessEnvironment` applies the layout. */
  readonly environment: NodeJS.ProcessEnv;
}

/**
 * Resolves an enabled Codex instance, including a default one the legacy `providers.codex`
 * settings define. Fails when it is missing, disabled, not Codex, or its config does not decode.
 */
export const resolveCodexInstanceRuntime = Effect.fn("resolveCodexInstanceRuntime")(function* (
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
): Effect.fn.Return<
  CodexInstanceRuntime,
  Schema.SchemaError | Cause.NoSuchElementError,
  Path.Path
> {
  const instance = providerInstanceConfigFor(settings, instanceId);
  if (instance?.driver !== "codex") return yield* new Cause.NoSuchElementError();
  const codex = yield* Schema.decodeUnknownEffect(CodexSettings)(instance.config ?? {});
  if (!resolveInstanceEnabled(instance, codex)) return yield* new Cause.NoSuchElementError();
  const { environment, layout } = yield* resolveCodexInstanceLayout(codex, instance.environment);
  return { instanceId, binaryPath: codex.binaryPath, layout, environment };
});
