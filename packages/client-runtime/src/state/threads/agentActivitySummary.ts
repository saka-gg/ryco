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
import { applicableUsageLimit } from "@ryco/shared/usageLimit";

import {
  compareThreadAttention,
  resolveThreadAttentionReason,
  type ThreadAttentionCandidate,
  type ThreadAttentionRow,
  type ThreadAttentionRowState,
} from "./threadAttention.ts";
import { deriveThreadActivityStatus } from "./threadActivityStatus.ts";
import { isThreadFailed } from "./threadFailure.ts";
import { isDelegatedThreadLineage } from "./threadLineage.ts";
import type { SidebarThreadSummary } from "./types.ts";

/** How long an unseen result stays on the glance after its turn ended. */
export const AGENT_ACTIVITY_RECENT_RESULT_MS = 15 * 60_000;
/** Rows a glance shows at most; the counts cover the rest. */
export const AGENT_ACTIVITY_MAX_ROWS = 5;
export const AGENT_ACTIVITY_TITLE_MAX = 48;
export const AGENT_ACTIVITY_PROJECT_MAX = 24;
export const AGENT_ACTIVITY_MODEL_MAX = 24;
export const AGENT_ACTIVITY_PARENT_MAX = 32;

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
  /** When its running turn started, or null when none runs (or the client does not know). */
  readonly turnStartedAtMs?: number | null;
  /** The model it works with, as people read it; null when unknown. */
  readonly modelName?: string | null;
  /** A delegated thread's parent, by title (`delegatedParentTitle`); null otherwise. */
  readonly parentTitle?: string | null;
  /** Newest first among equals. */
  readonly updatedAtMs: number;
}

export interface AgentActivityRow {
  readonly key: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
  readonly projectName: string | null;
  readonly modelName: string | null;
  /** The thread that delegated this one, by title, when it was delegated; absent otherwise. */
  readonly parentTitle?: string | null;
  readonly phase: AgentActivityPhase;
  /**
   * Since when it is in this phase, epoch ms, for an elapsed time: the running turn's start, the
   * last change of a thread that waits on the person, or when a result came. Null when unknown.
   */
  readonly sinceMs: number | null;
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

/**
 * A thread's row state as its own, connected and current machine sees it: what the phone's Inbox
 * row shows once the machine-level states (offline, delivery check, reconnecting) are ruled out.
 * The phone's rows and the node's own counts both start from it.
 */
export function liveThreadRowState(thread: SidebarThreadSummary): ThreadAttentionRowState {
  const activity = deriveThreadActivityStatus(thread);
  if (activity === "approval" || activity === "input" || activity === "plan-ready") {
    return "needs-input";
  }
  if (activity === "working") return "working";
  if (activity === "connecting") return "connecting";
  // A usage limit outranks the generic error it ended in (the web's and the phone's rule).
  if (applicableUsageLimit(thread) !== null) return "limited";
  // A restart release is an interruption, not a failure.
  if (isThreadFailed(thread)) return "error";
  return "idle";
}

const epochMs = (iso: string | null | undefined): number | null => {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
};

/**
 * The fields of an {@link AgentActivityThread} that come from the thread itself, the same for
 * every surface that builds one: what it waits on, whether it is a delegated child, and when its
 * turn started or ended.
 */
export function agentActivityThreadFields(
  thread: SidebarThreadSummary,
): Pick<
  AgentActivityThread,
  "attention" | "delegated" | "finishedAtMs" | "turnStartedAtMs" | "updatedAtMs"
> {
  const status = deriveThreadActivityStatus(thread);
  const running = thread.latestTurn?.state === "running";
  return {
    attention:
      status === "approval"
        ? "approval"
        : status === "input"
          ? "input"
          : status === "plan-ready"
            ? "plan"
            : null,
    delegated: isDelegatedThreadLineage(thread.lineage),
    finishedAtMs: running ? null : epochMs(thread.latestTurn?.completedAt),
    turnStartedAtMs: running
      ? epochMs(thread.latestTurn?.startedAt ?? thread.latestTurn?.requestedAt)
      : null,
    updatedAtMs: epochMs(thread.updatedAt) ?? 0,
  };
}

/** Trimmed and shortened, or null when nothing is left. */
function optionalText(text: string | null | undefined, max: number): string | null {
  return text === null || text === undefined || !text.trim() ? null : truncate(text, max);
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

function sinceOf(thread: AgentActivityThread, phase: AgentActivityPhase): number | null {
  const known = (value: number | null | undefined) =>
    value !== null && value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
  if (phase === "running" || phase === "connecting") return known(thread.turnStartedAtMs);
  if (phase === "failed" || phase === "done") return known(thread.finishedAtMs);
  // Nothing streams while a thread waits on the person: its last change is when it began to wait.
  return known(thread.updatedAtMs);
}
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

/**
 * Each environment's "needs you" count by {@link summarizeAgentActivity}'s rule (live threads
 * only): what a node seals into its alerts for the app icon badge, and what the phone counts live.
 */
export function countNeedsYouByEnvironment(
  threads: ReadonlyArray<AgentActivityThread>,
  nowMs: number,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const thread of threads) {
    if (!thread.live) continue;
    const phase = phaseOf(thread, nowMs);
    if (phase === null || !NEEDS_YOU.has(phase)) continue;
    counts.set(thread.environmentId, (counts.get(thread.environmentId) ?? 0) + 1);
  }
  return counts;
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
        modelName: optionalText(thread.modelName, AGENT_ACTIVITY_MODEL_MAX),
        parentTitle: optionalText(thread.parentTitle, AGENT_ACTIVITY_PARENT_MAX),
        phase,
        sinceMs: sinceOf(thread, phase),
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
