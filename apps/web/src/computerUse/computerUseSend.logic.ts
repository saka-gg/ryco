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
  /**
   * An explicit `/computer-use` task waited on the desktop (`prepare`), which may show setup:
   * the caller re-checks a draft edited meanwhile. A default send never sets it, so it is never
   * dropped for an edit.
   */
  readonly prepared: boolean;
  /** A default send went without Computer Use because required permissions are missing. */
  readonly setupMissing: boolean;
}

/** How long a default send waits for Computer Use before it goes without it. */
export const DEFAULT_COMPUTER_SEND_DEADLINE_MS = 1_500;

const NO_COMPUTER: ComputerSendResolution = { intent: null, prepared: false, setupMissing: false };

/**
 * Decides whether a send from this Mac carries a Computer intent.
 *
 * The desktop's `prepare` decides about permissions: it refreshes them first. The cached
 * `getState` is unknown until something checks, so gating on it dropped the intent of the first
 * send after a desktop start, and that turn's session listed no Computer tools. An explicit
 * `/computer-use` task throws what blocks it; a default (every chat) send goes without it, and
 * never waits on it longer than `deadlineMs` nor fails because of it.
 */
export async function resolveComputerSendIntent(input: {
  readonly threadId: string;
  readonly explicit: boolean;
  readonly computer: Pick<NonNullable<DesktopBridge["computerBeta"]>, "getState" | "prepare">;
  /** `computerUseSendBlocker` for the selected provider and this node's settings. */
  readonly readBlocker: () => Promise<string | null>;
  /** A default send's bound; `/computer-use` waits as long as setup takes. */
  readonly deadlineMs?: number;
}): Promise<ComputerSendResolution> {
  if (input.explicit) {
    const blocker = await input.readBlocker();
    if (blocker !== null) throw new Error(blocker);
    const intent = await input.computer.prepare(input.threadId, true);
    if (intent) return { intent, prepared: true, setupMissing: false };
    const setupMissing = (await input.computer.getState()).setup.missing.length > 0;
    return { intent: null, prepared: true, setupMissing };
  }
  const resolution = resolveDefaultSend(input).catch(() => NO_COMPUTER);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ComputerSendResolution>((resolve) => {
    timer = setTimeout(
      () => resolve(NO_COMPUTER),
      input.deadlineMs ?? DEFAULT_COMPUTER_SEND_DEADLINE_MS,
    );
  });
  try {
    return await Promise.race([resolution, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function resolveDefaultSend(input: {
  readonly threadId: string;
  readonly computer: Pick<NonNullable<DesktopBridge["computerBeta"]>, "getState" | "prepare">;
  readonly readBlocker: () => Promise<string | null>;
}): Promise<ComputerSendResolution> {
  if (!(await input.computer.getState()).preferences.defaultEnabled) return NO_COMPUTER;
  if ((await input.readBlocker()) !== null) return NO_COMPUTER;
  const intent = await input.computer.prepare(input.threadId, false);
  if (intent) return { intent, prepared: false, setupMissing: false };
  // `prepare` just refreshed the permissions, so this state is current.
  const setupMissing = (await input.computer.getState()).setup.missing.length > 0;
  return { intent: null, prepared: false, setupMissing };
}
