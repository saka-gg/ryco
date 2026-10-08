/**
 * Pure row text for the agent roster surfaces (the Agents panel and the
 * crown's Subagents detail): elapsed time and what an agent is doing now.
 */
import type { RuntimeSubagent } from "../../threadWorkspaceViewModel";

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

/** Elapsed time between two instants; a null end means now. */
export function elapsedBetween(startedAt: string, endIso: string | null): string {
  const start = Date.parse(startedAt);
  const end = endIso ? Date.parse(endIso) : Date.now();
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
