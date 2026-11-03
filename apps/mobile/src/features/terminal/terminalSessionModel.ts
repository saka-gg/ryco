import type { TerminalEvent, TerminalSessionStatus } from "@ryco/contracts";

export const MAX_MOBILE_TERMINAL_SESSIONS = 8;
export const MAX_TERMINAL_LABEL_CODE_POINTS = 32;
/** The terminal the explicit Start action opens; the same id every client starts first. */
export const MOBILE_DEFAULT_TERMINAL_ID = "default";

export type MobileTerminalStatus = TerminalSessionStatus;

export interface TerminalTabModel {
  readonly terminalId: string;
  readonly label: string;
  readonly active: boolean;
  readonly status: MobileTerminalStatus;
  readonly hasRunningSubprocess: boolean;
  readonly exitCode: number | null;
}

export interface TerminalHeaderActivityModel {
  readonly sessionCount: number;
  readonly hasRunningSubprocess: boolean;
  readonly badgeLabel: string | null;
  readonly accessibilityLabel: string;
}

/** The thread's terminal state as the shared store keeps it, or `null` for none recorded. */
export interface ThreadTerminalSessions {
  readonly terminalIds: readonly string[];
  readonly runningTerminalIds: readonly string[];
  readonly activeTerminalId: string;
}

export function createMobileTerminalId(uuid: string): string {
  const normalized = uuid.trim().toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(normalized)
  ) {
    throw new Error("A canonical UUID is required to create a terminal id.");
  }
  return `mobile-${normalized}`;
}

export function defaultTerminalLabel(index: number): string {
  return `Terminal ${Math.max(1, Math.trunc(index))}`;
}

export function normalizeTerminalLabel(label: string, fallback: string): string {
  const normalized = label.trim();
  if (normalized.length === 0) return fallback;
  return [...normalized].slice(0, MAX_TERMINAL_LABEL_CODE_POINTS).join("");
}

export function canCreateMobileTerminalSession(terminalIds: readonly string[]): boolean {
  return new Set(terminalIds).size < MAX_MOBILE_TERMINAL_SESSIONS;
}

/**
 * The sessions a thread has, as far as this device knows.
 *
 * The shared store drops a thread's record while it equals the default shape
 * (one closed `default` terminal), so a `default` session the node reported
 * only through events would otherwise read as none. Merely rendering a thread
 * never creates a session: with no record and no events there is none.
 */
export function knownTerminalSessionIds(input: {
  readonly sessions: ThreadTerminalSessions | null;
  readonly defaultTerminalHasEvents: boolean;
}): readonly string[] {
  if (input.sessions) return input.sessions.terminalIds;
  return input.defaultTerminalHasEvents ? [MOBILE_DEFAULT_TERMINAL_ID] : [];
}

export function selectRetainedRendererTerminalIds(input: {
  readonly activeTerminalId: string;
  readonly knownTerminalIds: readonly string[];
  readonly recentTerminalIds: readonly string[];
  readonly maxRetained?: number;
}): readonly string[] {
  const maxRetained = Math.max(1, Math.trunc(input.maxRetained ?? MAX_MOBILE_TERMINAL_SESSIONS));
  const known = new Set(input.knownTerminalIds);
  const retained: string[] = [];
  const append = (terminalId: string) => {
    if (!known.has(terminalId) || retained.includes(terminalId) || retained.length >= maxRetained) {
      return;
    }
    retained.push(terminalId);
  };
  append(input.activeTerminalId);
  for (const terminalId of input.recentTerminalIds) append(terminalId);
  for (const terminalId of input.knownTerminalIds) append(terminalId);
  return retained;
}

export interface TerminalStatusSummary {
  readonly status: MobileTerminalStatus;
  readonly exitCode: number | null;
}

/** A session's status after one more event; output, activity and clears leave it running. */
export function advanceTerminalStatus(
  current: TerminalStatusSummary,
  event: TerminalEvent,
): TerminalStatusSummary {
  switch (event.type) {
    case "started":
    case "restarted":
      return { status: event.snapshot.status, exitCode: event.snapshot.exitCode };
    case "output":
    case "activity":
    case "cleared":
      return current.status === "running" ? current : { status: "running", exitCode: null };
    case "exited":
      return { status: "exited", exitCode: event.exitCode };
    case "error":
      return { status: "error", exitCode: null };
  }
}

export function terminalStatusFromEvents(
  events: readonly TerminalEvent[],
  initial: TerminalStatusSummary = { status: "starting", exitCode: null },
): TerminalStatusSummary {
  let summary = initial;
  for (const event of events) summary = advanceTerminalStatus(summary, event);
  return summary;
}

export function buildTerminalTabs(input: {
  readonly terminalIds: readonly string[];
  readonly activeTerminalId: string;
  readonly runningTerminalIds: readonly string[];
  readonly labelsByTerminalId?: Readonly<Record<string, string>>;
  readonly statusByTerminalId: Readonly<Record<string, TerminalStatusSummary>>;
}): readonly TerminalTabModel[] {
  const running = new Set(input.runningTerminalIds);
  return input.terminalIds.map((terminalId, index) => {
    const summary = input.statusByTerminalId[terminalId] ?? { status: "starting", exitCode: null };
    return {
      terminalId,
      label: normalizeTerminalLabel(
        input.labelsByTerminalId?.[terminalId] ?? "",
        defaultTerminalLabel(index + 1),
      ),
      active: terminalId === input.activeTerminalId,
      status: summary.status,
      hasRunningSubprocess: running.has(terminalId),
      exitCode: summary.exitCode,
    };
  });
}

export function buildTerminalHeaderActivity(input: {
  readonly terminalIds: readonly string[];
  readonly runningTerminalIds: readonly string[];
}): TerminalHeaderActivityModel {
  const sessionCount = new Set(input.terminalIds).size;
  const hasRunningSubprocess = input.runningTerminalIds.length > 0;
  const sessionCopy = `${sessionCount} terminal ${sessionCount === 1 ? "session" : "sessions"}`;
  return {
    sessionCount,
    hasRunningSubprocess,
    badgeLabel: sessionCount > 1 ? (sessionCount > 99 ? "99+" : String(sessionCount)) : null,
    accessibilityLabel:
      sessionCount === 0
        ? "Open terminal. No terminal sessions."
        : `Open terminal. ${sessionCopy}.${hasRunningSubprocess ? " A subprocess is running." : ""}`,
  };
}
