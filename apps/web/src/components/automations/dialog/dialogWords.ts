/**
 * The dialog's words, as the lab's direction C says them. Pure; schedule math
 * and times come from `@ryco/shared/automationSchedule`.
 *
 * Vocabulary: runs are "waiting for approval", schedule changes are
 * "proposed", "Dispatched" never means done.
 */
import type { AgentControlAutomation, AutomationCentreRun } from "@ryco/contracts";
import {
  AUTOMATION_RUN_STATUS,
  isSchedulePaused,
  type ScheduleProposal,
  type ScheduleProposalKind,
  type ScheduleRow,
  type ScheduleRowState,
} from "@ryco/client-runtime/state/agentControl";
import {
  countRuns,
  firstRun,
  formatDate,
  lastRun,
  nextRun,
  scheduleToMs,
  when,
} from "@ryco/shared/automationSchedule";

/** "1 run" · "3 runs" · "2 missed" */
export function plural(n: number, word: string, words = `${word}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? word : words}`;
}

export function runStatusLabel(status: AutomationCentreRun["run"]["status"]): string {
  return AUTOMATION_RUN_STATUS[status].label;
}

/** The detail sentence's verb. */
export function detailVerb(state: ScheduleRowState): "Runs" | "Would run" | "Ran" {
  if (state === "finished") return "Ran";
  if (state === "paused" || state === "pending-create" || state === "lapsed") return "Would run";
  return "Runs";
}

// ── Proposals ────────────────────────────────────────────────────────

export const PROPOSAL_HEAD: Readonly<Record<ScheduleProposalKind, string>> = {
  create: "New schedule waiting for your approval",
  edit: "Change waiting for your approval",
  pause: "Pause waiting for your approval",
  resume: "Resume waiting for your approval",
  cancel: "Cancel waiting for your approval",
};

export function approveProposalLabel(kind: ScheduleProposalKind): string {
  if (kind === "cancel") return "Approve cancel";
  if (kind === "create") return "Approve schedule";
  return "Approve change";
}

export function rejectProposalLabel(kind: ScheduleProposalKind): string {
  return kind === "create" ? "Withdraw" : "Reject";
}

/** The line under a proposal: what keeps happening until it is decided. */
export function proposalNote(
  proposal: ScheduleProposal,
  automation: AgentControlAutomation | null,
  nowMs: number,
): string {
  switch (proposal.kind) {
    case "edit":
      return "The current schedule keeps running until you approve.";
    case "pause":
      return automation?.nextRunAt
        ? `Still runs ${when(automation.nextRunAt, nowMs)} unless you approve.`
        : "";
    case "resume": {
      const next = proposal.after ? nextRun(proposal.after.schedule, nowMs) : null;
      return next === null ? "" : `Approving resumes it; the first run is ${when(next, nowMs)}.`;
    }
    case "cancel":
      return "Cancelling is final. The run history stays.";
    default:
      return "";
  }
}

const LAPSED_WHAT: Readonly<Record<ScheduleProposalKind, string>> = {
  create: "This new schedule",
  edit: "Your change",
  pause: "Your pause",
  resume: "Your resume",
  cancel: "Your cancel",
};

/** A proposal that expired undecided: what to say and what "dismiss" is called. */
export function lapsedWords(kind: ScheduleProposalKind): {
  readonly title: string;
  readonly body: string;
  readonly dismiss: string;
} {
  return {
    title: `${LAPSED_WHAT[kind]} expired undecided`,
    body: `${kind === "create" ? "Nothing was created." : "Nothing changed."} Propose it again to ask for approval.`,
    dismiss: kind === "create" ? "Remove" : "Dismiss",
  };
}

// ── Header queue ─────────────────────────────────────────────────────

export function queueRunsLabel(count: number, title: string, expiresAt: string): string {
  return count === 1
    ? `${title}: run waiting for approval, expires ${expiresAt}. Show it`
    : `${count} runs waiting for approval, the first expires ${expiresAt}. Show it`;
}

export function queueChangesLabel(count: number): string {
  return `${plural(count, "change")} waiting for your approval. Show ${count === 1 ? "it" : "the first"}`;
}

// ── When ─────────────────────────────────────────────────────────────

/** The detail's "When" line: relative words and one absolute format. */
export type ScheduleWhenLine =
  | { readonly kind: "first"; readonly at: string; readonly tail: string | null }
  | { readonly kind: "quiet"; readonly text: string }
  | {
      readonly kind: "next";
      readonly at: string;
      readonly nextRunAt: number;
      readonly tail: string | null;
    };

export function scheduleWhenLine(row: ScheduleRow, nowMs: number): ScheduleWhenLine {
  const s = scheduleToMs(row.def.schedule);
  const automation = row.automation;
  if (row.state === "pending-create" || row.state === "lapsed" || !automation) {
    return {
      kind: "first",
      at: when(firstRun(s), nowMs),
      tail:
        s.kind === "once"
          ? null
          : `${plural(countRuns(s), "run")} until ${formatDate(s.endsAt, nowMs)}`,
    };
  }
  if (isSchedulePaused(automation))
    return {
      kind: "quiet",
      text: `No runs while paused. It ends ${formatDate(lastRun(s), nowMs)}.`,
    };
  if (row.nextRunAt === null || !automation.enabled)
    return { kind: "quiet", text: `No runs left. It ended ${formatDate(lastRun(s), nowMs)}.` };
  const more = s.kind === "once" ? 0 : countRuns(s, row.nextRunAt + 1);
  return {
    kind: "next",
    at: when(row.nextRunAt, nowMs),
    nextRunAt: row.nextRunAt,
    tail:
      s.kind === "once"
        ? null
        : more
          ? `${plural(more, "more run")} until ${formatDate(s.endsAt, nowMs)}`
          : "the last one",
  };
}

// ── Run history ──────────────────────────────────────────────────────

/** A finished run's line: missed occurrences, a retry marker, then what happened. */
export function runHistoryText(
  entry: AutomationCentreRun,
  threadTitle: string | null,
): {
  readonly missed: string | null;
  readonly retry: boolean;
  readonly text: string;
  readonly tone: "" | "err";
} {
  const { run } = entry;
  const missed = run.coalescedOccurrences
    ? `${plural(run.coalescedOccurrences, "missed", "missed")} → 1 · `
    : null;
  switch (run.status) {
    case "completed":
      return {
        missed,
        retry: entry.retryOfRunId !== null,
        text: threadTitle ?? "Thread started",
        tone: "",
      };
    case "failed":
      return {
        missed,
        retry: false,
        text: run.safeFailureDetail ?? "Couldn't start.",
        tone: "err",
      };
    case "expired":
      return { missed, retry: false, text: "Not approved within 15 min", tone: "" };
    case "rejected":
      return { missed, retry: false, text: "Rejected before it started", tone: "" };
    case "cancelled":
      return { missed, retry: false, text: run.safeFailureDetail ?? "Cancelled", tone: "" };
    default:
      return { missed: null, retry: false, text: "", tone: "" };
  }
}

export function runAriaLabel(entry: AutomationCentreRun, nowMs: number): string {
  return `${runStatusLabel(entry.run.status)}${entry.unread ? ", unread" : ""}, ${when(entry.run.scheduledFor, nowMs)}`;
}
