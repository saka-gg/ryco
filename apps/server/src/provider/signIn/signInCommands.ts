/**
 * Which login a provider instance runs in a sign-in terminal, decided from its settings alone: the
 * driver's CLI with its own login arguments, run with the environment the driver gives that CLI.
 * A login that would not be used is refused, and so is one that belongs to another machine.
 *
 * The login arguments are taken from the references, not from running the CLIs: Synara's per-CLI
 * login table (`PROVIDER_AUTHENTICATION` in its `providerCliProfiles.ts`, checked there against each
 * CLI's authentication documentation) and the "run `<command> login`" hints the CLIs and Ryco's own
 * provider checks print. Copilot has no sign-in here until its login entry point is verified.
 *
 * @module signInCommands
 */
import {
  ClaudeSettings,
  CursorSettings,
  GrokSettings,
  OpenCodeSettings,
  type ProviderInstanceConfig,
} from "@ryco/contracts";
import { claudeNonLoginCredentialSource } from "@ryco/shared/claudeCredentialVariables";
import { Option, Schema } from "effect";

import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { resolveInstanceEnabled } from "../providerInstanceConfig.ts";

export type TerminalSignInDriver = "claudeAgent" | "cursor" | "grok" | "opencode";

export interface TerminalSignInLaunch {
  readonly driver: TerminalSignInDriver;
  /** The configured command: a name looked up on the instance's `PATH`, or a path. */
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /**
   * The instance's variables over the node's own, as its driver merges them. Claude's home and
   * config directory are applied when the login starts (`makeClaudeEnvironment`).
   */
  readonly environment: NodeJS.ProcessEnv;
  /** Claude's configured home; empty for the other drivers. */
  readonly homePath: string;
}

export type TerminalSignInPlan =
  | { readonly _tag: "invalid" }
  | { readonly _tag: "disabled" }
  | { readonly _tag: "refused"; readonly reason: string }
  | ({ readonly _tag: "ready" } & TerminalSignInLaunch);

/** Decoded, enabled, then launched, or refused with the reason `launch` gives. */
const plan = <T>(
  instance: ProviderInstanceConfig,
  config: Option.Option<T>,
  launch: (config: T) => string | Omit<TerminalSignInLaunch, "environment">,
  environment: NodeJS.ProcessEnv,
): TerminalSignInPlan => {
  if (Option.isNone(config)) return { _tag: "invalid" };
  if (!resolveInstanceEnabled(instance, config.value)) return { _tag: "disabled" };
  const launched = launch(config.value);
  return typeof launched === "string"
    ? { _tag: "refused", reason: launched }
    : { _tag: "ready", ...launched, environment };
};

/**
 * The terminal sign-in of an instance, or `undefined` when its driver has none. `baseEnv` is the
 * node's own environment; a variable set there counts like one the instance sets.
 */
export const planTerminalSignIn = (
  instance: ProviderInstanceConfig,
  baseEnv: NodeJS.ProcessEnv = process.env,
): TerminalSignInPlan | undefined => {
  const environment = mergeProviderInstanceEnvironment(instance.environment, baseEnv);
  switch (instance.driver) {
    case "claudeAgent":
      return plan(
        instance,
        Schema.decodeUnknownOption(ClaudeSettings)(instance.config ?? {}),
        (claude) => {
          // An API key, another provider, or a CLIProxyAPI hub (`ANTHROPIC_BASE_URL` and
          // `ANTHROPIC_AUTH_TOKEN`): Claude Code would not use a login, so none is made, and its
          // login store is never touched for such an instance. Named, never shown.
          const source = claudeNonLoginCredentialSource(environment);
          return source !== undefined
            ? `Claude uses ${source}, set for this instance or on the node, instead of a claude.ai login, so it has no login to sign in to.`
            : {
                driver: "claudeAgent",
                command: claude.binaryPath,
                args: ["auth", "login"],
                homePath: claude.homePath,
              };
        },
        environment,
      );
    case "cursor":
      return plan(
        instance,
        Schema.decodeUnknownOption(CursorSettings)(instance.config ?? {}),
        (cursor) => ({
          driver: "cursor",
          command: cursor.binaryPath,
          // The endpoint the driver's sessions use, so the login is for the same service.
          args: [...(cursor.apiEndpoint ? ["-e", cursor.apiEndpoint] : []), "login"],
          homePath: "",
        }),
        environment,
      );
    case "grok":
      return plan(
        instance,
        Schema.decodeUnknownOption(GrokSettings)(instance.config ?? {}),
        // Device authentication on every node, as Codex signs in: the page opens on the user's own
        // device, so a remote or headless node needs no browser and no localhost callback (the
        // documented form for such nodes, `docs/providers/grok.md`).
        (grok) => ({
          driver: "grok",
          command: grok.binaryPath,
          args: ["login", "--device-auth"],
          homePath: "",
        }),
        environment,
      );
    case "opencode":
      return plan(
        instance,
        Schema.decodeUnknownOption(OpenCodeSettings)(instance.config ?? {}),
        (openCode) =>
          openCode.serverUrl.trim().length > 0
            ? "This instance uses the OpenCode server at its server URL. Sign in on that server."
            : {
                driver: "opencode",
                command: openCode.binaryPath,
                args: ["auth", "login"],
                homePath: "",
              },
        environment,
      );
    default:
      return undefined;
  }
};
