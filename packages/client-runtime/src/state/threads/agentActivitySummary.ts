/**
 * What the phone's Live Activity (and any other glance surface) says about
 * agent work right now: how many threads run, wait on the user, or just ended,
 * and the few that matter most. Pure, and built from the same attention rule
 * as the Inbox and "next thread that needs you", so a glance never disagrees
 * with the list it opens. A working delegated child counts as running (its
 * parent usually waits with no turn of its own); its result belongs to the
 * parent, so it gets no result row.
 *
 * Rows are taken only from live machines: a cached or offline machine's state
 * is not current, so it never counts as running or waiting.
 */
import {
  compareThreadAttention,
  resolveThreadAttentionReason,
  type ThreadAttentionCandidate,
  type ThreadAttentionRow,
} from "./threadAttention.ts";

/** How long an unseen result stays on the glance after its turn ended. */
export const AGENT_ACTIVITY_RECENT_RESULT_MS = 15 * 60_000;
/** Rows a glance shows at most; the counts cover the rest. */
export const AGENT_ACTIVITY_MAX_ROWS = 5;
export const AGENT_ACTIVITY_TITLE_MAX = 48;
export const AGENT_ACTIVITY_PROJECT_MAX = 24;

export type AgentActivityPhase =
  | "approval"
  | "input"
  | "plan"
  | "running"
  | "connecting"
  | "failed"
  | "done";

export interface AgentActivityThread extends ThreadAttentionRow {
  readonly key: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
  readonly projectName: string | null;
  /** The thread's machine is connected and current; anything else is left out. */
  readonly live: boolean;
  /** When its latest turn ended, or null while one runs or none ran. */
  readonly finishedAtMs: number | null;
  /** Newest first among equals. */
  readonly updatedAtMs: number;
}

export interface AgentActivityRow {
  readonly key: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
  readonly projectName: string | null;
  readonly phase: AgentActivityPhase;
}

export interface AgentActivitySummary {
  readonly counts: {
    readonly running: number;
    readonly needsYou: number;
    readonly failed: number;
    readonly done: number;
  };
  readonly rows: ReadonlyArray<AgentActivityRow>;
  /** Nothing runs and nothing waits on the user: only results, if anything. */
  readonly settled: boolean;
}

/** Shortened by whole characters, so an emoji is never cut in half. */
function truncate(text: string, max: number): string {
  const characters = Array.from(text.trim());
  return characters.length <= max
    ? characters.join("")
    : `${characters
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`;
}

function phaseOf(thread: AgentActivityThread, nowMs: number): AgentActivityPhase | null {
  const reason = resolveThreadAttentionReason(thread);
  if (reason === "approval") return "approval";
  if (reason === "input") return "input";
  if (reason === "plan-ready") return "plan";
  if (thread.resting) return null;
  // A working delegated child is work: its parent usually waits for it with no turn of its own.
  if (thread.state === "working") return "running";
  if (thread.state === "connecting") return "connecting";
  // A delegated child's result returns to its parent (the attention rule): no row of its own.
  if (thread.delegated) return null;
  // A finish time ahead of this device's clock (the node's clock runs ahead) is "just now".
  const recent =
    thread.finishedAtMs !== null && nowMs - thread.finishedAtMs <= AGENT_ACTIVITY_RECENT_RESULT_MS;
  if (!recent) return null;
  if (reason === "failed") return "failed";
  if (reason === "completed") return "done";
  return null;
}

const NEEDS_YOU: ReadonlySet<AgentActivityPhase> = new Set(["approval", "input", "plan"]);
const RUNNING: ReadonlySet<AgentActivityPhase> = new Set(["running", "connecting"]);

/** Attention first (approval, input, plan, failed, done, as the Inbox orders it), then running. */
function compareRows(
  left: { readonly row: AgentActivityRow; readonly candidate: ThreadAttentionCandidate | null },
  right: { readonly row: AgentActivityRow; readonly candidate: ThreadAttentionCandidate | null },
  recencyMs: ReadonlyMap<string, number>,
): number {
  if (left.candidate && right.candidate) {
    return compareThreadAttention(left.candidate, right.candidate);
  }
  if (left.candidate) return -1;
  if (right.candidate) return 1;
  const recency = (key: string) => {
    const value = recencyMs.get(key);
    return value !== undefined && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
  };
  const leftMs = recency(left.row.key);
  const rightMs = recency(right.row.key);
  const byRecency = leftMs === rightMs ? 0 : rightMs > leftMs ? 1 : -1;
  return byRecency !== 0 ? byRecency : left.row.key.localeCompare(right.row.key);
}

export function summarizeAgentActivity(
  threads: ReadonlyArray<AgentActivityThread>,
  nowMs: number,
): AgentActivitySummary {
  const counts = { running: 0, needsYou: 0, failed: 0, done: 0 };
  const entries: Array<{
    readonly row: AgentActivityRow;
    readonly candidate: ThreadAttentionCandidate | null;
  }> = [];
  const recencyMs = new Map<string, number>();
  for (const thread of threads) {
    if (!thread.live) continue;
    const phase = phaseOf(thread, nowMs);
    if (phase === null) continue;
    if (NEEDS_YOU.has(phase)) counts.needsYou += 1;
    else if (RUNNING.has(phase)) counts.running += 1;
    else if (phase === "failed") counts.failed += 1;
    else counts.done += 1;
    const reason = resolveThreadAttentionReason(thread);
    recencyMs.set(thread.key, thread.updatedAtMs);
    entries.push({
      row: {
        key: thread.key,
        environmentId: thread.environmentId,
        threadId: thread.threadId,
        title: truncate(thread.title, AGENT_ACTIVITY_TITLE_MAX),
        projectName:
          thread.projectName === null
            ? null
            : truncate(thread.projectName, AGENT_ACTIVITY_PROJECT_MAX),
        phase,
      },
      candidate:
        reason === null ? null : { key: thread.key, reason, recencyMs: thread.updatedAtMs },
    });
  }
  const rows = entries
    .toSorted((left, right) => compareRows(left, right, recencyMs))
    .slice(0, AGENT_ACTIVITY_MAX_ROWS)
    .map((entry) => entry.row);
  return { counts, rows, settled: counts.running + counts.needsYou === 0 };
}
