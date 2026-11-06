import type { ComputerTurnIntent, DesktopBridge } from "@ryco/contracts";

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

/** What one send carries: the intent, or why a default send goes without Computer Use. */
export interface ComputerSendResolution {
  readonly intent: ComputerTurnIntent | null;
  /** The desktop was asked (`prepare`): the caller re-checks a draft edited meanwhile. */
  readonly prepared: boolean;
  /** A default send went without Computer Use because required permissions are missing. */
  readonly setupMissing: boolean;
}

/**
 * Decides whether a send from this Mac carries a Computer intent.
 *
 * The desktop's `prepare` decides about permissions: it refreshes them first. The cached
 * `getState` is unknown until something checks, so gating on it dropped the intent of the first
 * send after a desktop start, and that turn's session listed no Computer tools. An explicit
 * `/computer-use` task throws what blocks it; a default (every chat) send goes without it.
 */
export async function resolveComputerSendIntent(input: {
  readonly threadId: string;
  readonly explicit: boolean;
  readonly computer: Pick<NonNullable<DesktopBridge["computerBeta"]>, "getState" | "prepare">;
  /** `computerUseSendBlocker` for the selected provider and this node's settings. */
  readonly readBlocker: () => Promise<string | null>;
}): Promise<ComputerSendResolution> {
  const none = { intent: null, prepared: false, setupMissing: false } as const;
  const byDefault = !input.explicit && (await input.computer.getState()).preferences.defaultEnabled;
  if (!input.explicit && !byDefault) return none;
  const blocker = await input.readBlocker();
  if (blocker !== null) {
    if (input.explicit) throw new Error(blocker);
    return none;
  }
  const intent = await input.computer.prepare(input.threadId, input.explicit);
  if (intent) return { intent, prepared: true, setupMissing: false };
  // `prepare` just refreshed the permissions, so this state is current.
  const setupMissing = (await input.computer.getState()).setup.missing.length > 0;
  return { intent: null, prepared: true, setupMissing };
}
