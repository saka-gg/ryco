/** Providers whose Ryco sessions receive the private Computer Use tools. */
export const COMPUTER_USE_PROVIDERS: ReadonlySet<string> = new Set([
  "codex",
  "claudeAgent",
  "cursor",
  "copilot",
  "opencode",
]);

/**
 * Why this send cannot use the computer, or null. An explicit `/computer-use` task shows it;
 * a default (every chat) send goes without Computer Use instead.
 */
export function computerUseSendBlocker(input: {
  readonly provider: string;
  readonly agentControlEnabled: boolean;
  readonly externalOpenCode: boolean;
}): string | null {
  if (!COMPUTER_USE_PROVIDERS.has(input.provider))
    return "This provider does not support Computer Use. Select Codex, Claude, Cursor, Copilot or managed OpenCode.";
  if (!input.agentControlEnabled)
    return "Computer Use needs Agent Control. Turn on Computer Use in Settings → Computer Use.";
  if (input.externalOpenCode)
    return "Computer Use requires managed OpenCode. An external OpenCode server cannot receive local desktop access.";
  return null;
}

/** An OpenCode instance pointed at its own server, which never gets local desktop access. */
export function isExternalOpenCodeInstance(provider: string, config: unknown): boolean {
  return (
    provider === "opencode" &&
    config !== null &&
    typeof config === "object" &&
    "serverUrl" in config &&
    Boolean(config.serverUrl)
  );
}
