/**
 * Pure row text every agent roster surface shares (web's Agents panel and the
 * crown's Subagents detail, the phone's agents sheet): whether a thread's
 * agents can still be live, each status in words, elapsed time and what an
 * agent is doing now.
 */
import type { ThreadSession } from "../threads/types.ts";
import { derivePhase } from "./session-logic.ts";
import type { RuntimeSubagent, RuntimeSubagentStatus } from "./subagentRuntime.ts";

/**
 * Whether the thread's provider session can still be running agents. A dead or
 * stopped session leaves its running agents interrupted, never live.
 */
export function isThreadAgentSessionLive(session: ThreadSession | null | undefined): boolean {
  return (
    derivePhase(session ?? null) !== "disconnected" &&
    session?.orchestrationStatus !== "stopped" &&
    session?.orchestrationStatus !== "interrupted" &&
    session?.orchestrationStatus !== "error"
  );
}

export interface SubagentStatusText {
  /** The status in full, for a detail header or an accessible name. */
  readonly label: string;
  /**
   * The word a row sets beside its time. Null for running and completed,
   * which read from the status dot and the ticking or frozen time alone; every
   * other state is named so it never depends on color (or a stale activity line).
   */
  readonly word: string | null;
}

/** Provider phases remain distinct, including resumable idle agents. */
export const SUBAGENT_STATUS_TEXT: Readonly<Record<RuntimeSubagentStatus, SubagentStatusText>> = {
  pending: { label: "Queued", word: "Queued" },
  running: { label: "Running", word: null },
  waiting: { label: "Waiting", word: "Waiting" },
  idle: { label: "Idle · resumable", word: "Idle" },
  completed: { label: "Completed", word: null },
  failed: { label: "Failed", word: "Failed" },
  cancelled: { label: "Stopped", word: "Stopped" },
  interrupted: { label: "Interrupted", word: "Interrupted" },
};

export function formatElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) {
    return `${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours === 0) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Elapsed time between two instants; a null end means `nowMs`. */
export function elapsedBetween(
  startedAt: string,
  endIso: string | null,
  nowMs: number = Date.now(),
): string {
  const start = Date.parse(startedAt);
  const end = endIso ? Date.parse(endIso) : nowMs;
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return "";
  }
  return formatElapsedSeconds((end - start) / 1000);
}

/**
 * How long a settled agent actually ran. The provider's own duration_ms is
 * authoritative when reported; activity timestamps are the fallback for
 * synthesized rows (workflow members) that carry no usage duration.
 */
export function settledDuration(agent: RuntimeSubagent): string | null {
  if (agent.usage?.durationMs !== undefined) {
    return formatElapsedSeconds(agent.usage.durationMs / 1000);
  }
  if (agent.startedAt && agent.completedAt) {
    return elapsedBetween(agent.startedAt, agent.completedAt);
  }
  return null;
}

/**
 * Human label for an agent's last tool. The Workflow harness makes agents
 * deliver their result through an internal tool literally named
 * "StructuredOutput" — surfacing that verbatim reads like a bug, so it maps
 * to result language instead.
 */
export function agentToolHint(name: string, live: boolean): string {
  if (/^structured[\s_-]?output$/i.test(name)) {
    return live ? "Delivering result" : "Delivered result";
  }
  return live ? `Using ${name}` : name;
}

/**
 * Status-dependent activity line. Live rows lead with what is happening now;
 * settled rows lead with the outcome. Errors are the only inline previews on
 * failed rows because they explain a red row at a glance.
 */
export function agentActivityText(agent: RuntimeSubagent): string | null {
  const live =
    agent.status === "running" || agent.status === "pending" || agent.status === "waiting";
  if (live) {
    return (
      agent.progress ??
      (agent.lastToolName ? agentToolHint(agent.lastToolName, true) : null) ??
      agent.result ??
      agent.error
    );
  }
  return (
    agent.error ??
    agent.result ??
    agent.progress ??
    (agent.lastToolName ? agentToolHint(agent.lastToolName, false) : null)
  );
}
