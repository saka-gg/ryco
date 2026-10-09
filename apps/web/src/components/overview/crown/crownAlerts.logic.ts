import type { OrchestrationLatestTurnState } from "@ryco/contracts";

import { formatCount } from "~/lib/formatCount";
import type { TurnCompletionOutcome } from "~/lib/turnCompletion.logic";

import type { PrCheckStatusKind } from "../../projectExplorer/prCheckStatus";
import {
  agentWorkflowMembers,
  buildAgentRosterIdentity,
  canonicalSubagentIdentityKey,
  emptyAgentPanelModel,
  isActiveSubagentStatus,
  isTerminalSubagentStatus,
  resolveAgentRowIdentity,
  summarizeAgentWorkflow,
  type AgentPanelModel,
  type RuntimeSubagent,
  type RuntimeSubagentStatus,
} from "../../../threadWorkspaceViewModel";
import { formatElapsedDurationLabel } from "../../../timestampFormat";
import { getOverviewSummary } from "../overviewSummary.logic";
import type { OverviewDataReadiness, OverviewLayoutProps } from "../overviewTypes";
import { countCrownChecks, crownKnownPrState, type CrownPrState } from "./crownModel.logic";
import type { CrownRailKey, CrownSection, CrownTone } from "./crownSections";
import { noteSummaryText } from "../notes/noteText.logic";
import type { CrownNotesBinding, CrownTurnInput } from "./crownTypes";

/**
 * Crown alerts are derived, not pushed: every render reduces the overview to a
 * small comparable {@link CrownSnapshot}, and {@link diffCrownSnapshots}
 * turns the difference between the last baseline and the new snapshot into
 * events. Loud events morph the crown into an alert; quiet ones only ping
 * their rail icon (the prototype's LOUD list, slightly quieter: plan steps,
 * file counts and a check starting never take over the crown).
 *
 * Data hydrates in stages (git status local then remote, a PR number before
 * its detail), so a field that is still unknown is null, and only a change
 * between two known values is a transition. The baseline adopts a newly
 * known value silently.
 */

export interface CrownSnapshot {
  /** Thread + checkout. A change re-baselines silently. */
  readonly scopeKey: string;
  /** The latest turn, as the turn-completion tracker observes it. */
  readonly turn: {
    readonly turnId: string;
    readonly state: OrchestrationLatestTurnState;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
    readonly settled: boolean;
    /** The session is running. */
    readonly running: boolean;
  } | null;
  /** Null while loading or when the status is unavailable; the baseline keeps the last known value. */
  readonly checks: {
    readonly headSha: string | null;
    readonly kind: PrCheckStatusKind;
    readonly failed: ReadonlyArray<string>;
    readonly passed: number;
    readonly total: number;
    readonly refName: string | null;
  } | null;
  /**
   * Null without a known pull request; the baseline keeps the last known one.
   * Each field is null until its source has reported it.
   */
  readonly pr: {
    readonly number: number;
    readonly state: Exclude<CrownPrState, "draft"> | null;
    readonly isDraft: boolean | null;
    /** Known once the PR detail has loaded. */
    readonly approvals: number | null;
    /** Known once the PR detail reports mergeability. */
    readonly conflicting: boolean | null;
  } | null;
  /** The change-request lookup has answered, so a null `pr` is a real "no PR". */
  readonly prSettled: boolean;
  readonly branch: {
    readonly refName: string | null;
    /** Null until git status has its remote half. */
    readonly ahead: number | null;
    readonly behind: number | null;
  };
  readonly plan: {
    readonly turnId: string | null;
    readonly completedSteps: ReadonlyArray<string>;
    readonly total: number;
  } | null;
  readonly agents: CrownAgentsSnapshot;
  readonly fileCount: number;
  /**
   * The worktree view's notes by id, in list order; null until the node's
   * notes have answered. `own` marks notes this client created.
   */
  readonly notes: Readonly<
    Record<string, { readonly summary: string; readonly own: boolean }>
  > | null;
}

/** One workflow run as its alerts read it; members only surface as failures. */
export interface CrownWorkflowSnapshot {
  readonly name: string;
  /** The coordinator's status. */
  readonly status: RuntimeSubagentStatus;
  readonly phaseCount: number;
  readonly memberCount: number;
  /** Failed member ids, in roster order. */
  readonly failedMemberIds: ReadonlyArray<string>;
  /** The first failed member's row label. */
  readonly firstFailedName: string | null;
}

/** Runtime agents by id: direct spawns alert one by one, workflows once per run. */
export interface CrownAgentsSnapshot {
  readonly direct: Readonly<
    Record<string, { readonly status: RuntimeSubagentStatus; readonly name: string }>
  >;
  readonly workflows: Readonly<Record<string, CrownWorkflowSnapshot>>;
}

export type CrownEventKind =
  | "checks"
  | "pr"
  | "branch"
  | "subagent"
  | "plan"
  | "turn"
  | "changes"
  | "note";
export type CrownEventIcon =
  | "x"
  | "check"
  | "upload"
  | "commit"
  | "bot"
  | "workflow"
  | "pr"
  | "sparkles"
  | "turn"
  | "note";

export interface CrownEvent {
  readonly id: string;
  /** Card section "View" opens. */
  readonly section: CrownSection;
  /** Rail icon that pings. */
  readonly railKey: CrownRailKey;
  readonly tone: CrownTone;
  readonly kind: CrownEventKind;
  readonly title: string;
  readonly sub?: string;
  readonly icon: CrownEventIcon;
  /** Loud events take over the crown; quiet ones only ping their icon. */
  readonly loud: boolean;
  /** Identical for the same transition, so flapping data can't alert twice. */
  readonly dedupeKey: string;
  /** The note a "Note saved" alert is about; View highlights it. */
  readonly noteId?: string;
}

export interface CrownDiffContext {
  readonly nowMs: number;
  /** Branch and "PR opened" alerts are dropped until then: the user's own git action already toasted. */
  readonly suppressGitUntilMs: number;
  /** How the latest turn just ended, from the turn-completion tracker fed this snapshot. */
  readonly turnOutcome: TurnCompletionOutcome | null;
}

const UNSETTLED_CHECK_KINDS: ReadonlySet<PrCheckStatusKind> = new Set([
  "loading",
  "unavailable",
  "api-error",
]);
const IN_FLIGHT_CHECK_KINDS: ReadonlySet<PrCheckStatusKind> = new Set(["pending", "running"]);

/** Subagent (and note) events in one diff at or above this count collapse into one. */
export const CROWN_SUBAGENT_BURST_MIN = 3;
/** The "Note saved" alert's sub line (prototype `trunc(stripTodo(sub), 40)`). */
export const CROWN_NOTE_SUMMARY_MAX = 40;

export function buildCrownSnapshot(input: {
  readonly scopeKey: string;
  readonly layout: OverviewLayoutProps;
  readonly readiness: OverviewDataReadiness;
  readonly latestTurn: CrownTurnInput | null;
  readonly turnSettled: boolean;
  readonly agentRunning: boolean;
  readonly notes?: CrownNotesBinding | undefined;
}): CrownSnapshot {
  const { layout, latestTurn, readiness } = input;
  const summary = getOverviewSummary(layout);
  const pullRequest = layout.pullRequest ?? null;
  const checkStatus = pullRequest?.checkStatus ?? null;

  let checks: CrownSnapshot["checks"] = null;
  if (checkStatus && !UNSETTLED_CHECK_KINDS.has(checkStatus.kind)) {
    const counts = countCrownChecks(pullRequest);
    checks = {
      headSha: checkStatus.headSha ?? null,
      kind: checkStatus.kind,
      failed: counts.failedNames,
      passed: counts.passed,
      total: counts.total,
      refName: summary.refName,
    };
  }

  const activePlan = layout.activePlan;
  return {
    scopeKey: input.scopeKey,
    turn: latestTurn
      ? {
          turnId: latestTurn.turnId,
          state: latestTurn.state,
          startedAt: latestTurn.startedAt,
          completedAt: latestTurn.completedAt,
          settled: input.turnSettled,
          running: input.agentRunning,
        }
      : null,
    checks,
    pr:
      typeof pullRequest?.number === "number"
        ? {
            number: pullRequest.number,
            state: crownKnownPrState(pullRequest.state),
            isDraft: typeof pullRequest.isDraft === "boolean" ? pullRequest.isDraft : null,
            approvals:
              typeof pullRequest.reviewsApproved === "number" ? pullRequest.reviewsApproved : null,
            conflicting: pullRequest.mergeability ? pullRequest.hasMergeConflicts : null,
          }
        : null,
    prSettled: readiness.pullRequestLookup,
    branch: readiness.remoteStatus
      ? { refName: summary.refName, ahead: summary.aheadCount, behind: summary.behindCount }
      : { refName: summary.refName, ahead: null, behind: null },
    plan: activePlan
      ? {
          turnId: activePlan.turnId ?? null,
          completedSteps: activePlan.steps
            .filter((step) => step.status === "completed")
            .map((step) => step.step),
          total: activePlan.steps.length,
        }
      : null,
    agents: snapshotAgents(layout.agentPanelModel ?? emptyAgentPanelModel()),
    fileCount: summary.fileCount,
    notes: snapshotNotes(input.notes),
  };
}

/**
 * Agent snapshots by model. The snapshot is rebuilt and serialised on every
 * render, while the model only changes with agent activity, and its roster
 * labels are the costly part.
 */
const agentSnapshots = new WeakMap<AgentPanelModel, CrownAgentsSnapshot>();
function snapshotAgents(model: AgentPanelModel): CrownAgentsSnapshot {
  let snapshot = agentSnapshots.get(model);
  if (snapshot === undefined) {
    snapshot = buildAgentsSnapshot(model);
    agentSnapshots.set(model, snapshot);
  }
  return snapshot;
}

function buildAgentsSnapshot(model: AgentPanelModel): CrownAgentsSnapshot {
  if (!model.hasAgents) return { direct: {}, workflows: {} };
  const roster = buildAgentRosterIdentity(model);
  const label = (agent: RuntimeSubagent) => resolveAgentRowIdentity(agent, roster).label;
  const direct: Record<string, { status: RuntimeSubagentStatus; name: string }> = {};
  // Keyed canonically: a transcript row (`subagent:x`) yields to its native
  // row (`x`) once native activity lands, and that must not read as new.
  for (const agent of model.directAgents) {
    direct[canonicalSubagentIdentityKey(agent.id)] = { status: agent.status, name: label(agent) };
  }
  const workflows: Record<string, CrownWorkflowSnapshot> = {};
  for (const group of model.workflows) {
    const summary = summarizeAgentWorkflow(group);
    const failed = agentWorkflowMembers(group).filter((member) => member.status === "failed");
    workflows[summary.id] = {
      name: summary.name,
      status: group.workflow.status,
      phaseCount: summary.phaseCount,
      memberCount: summary.memberCount,
      failedMemberIds: failed.map((member) => member.id),
      firstFailedName: failed[0] ? label(failed[0]) : null,
    };
  }
  return { direct, workflows };
}

/** Summaries by note entry: the binding keeps entries stable while their note is unchanged. */
const noteSummaries = new WeakMap<object, string>();
function noteSummary(note: CrownNotesBinding["alertNotes"][number]): string {
  let summary = noteSummaries.get(note);
  if (summary === undefined) {
    summary = noteSummaryText(note.body, CROWN_NOTE_SUMMARY_MAX);
    noteSummaries.set(note, summary);
  }
  return summary;
}

/** The confirmed Worktree view (no pending edits or deletes), so a rollback never "appears". */
function snapshotNotes(binding: CrownNotesBinding | undefined): CrownSnapshot["notes"] {
  if (!binding?.available || !binding.loaded) return null;
  const notes: Record<string, { summary: string; own: boolean }> = {};
  for (const note of binding.alertNotes) {
    notes[note.id] = { summary: noteSummary(note), own: binding.ownNoteIds.has(note.id) };
  }
  return notes;
}

/**
 * The baseline the next snapshot is diffed against. Checks, the pull request
 * and its fields, the ahead / behind counts and the notes flap to unknown
 * while they reload; keeping the last known value means the reload neither re-alerts
 * nor hides a transition across it.
 */
export function mergeCrownBaseline(prev: CrownSnapshot | null, next: CrownSnapshot): CrownSnapshot {
  if (!prev || prev.scopeKey !== next.scopeKey) return next;
  return {
    ...next,
    checks: next.checks ?? prev.checks,
    pr: mergePullRequest(prev.pr, next.pr),
    notes: next.notes ?? prev.notes,
    branch:
      prev.branch.refName === next.branch.refName
        ? {
            refName: next.branch.refName,
            ahead: next.branch.ahead ?? prev.branch.ahead,
            behind: next.branch.behind ?? prev.branch.behind,
          }
        : next.branch,
  };
}

function mergePullRequest(
  prev: CrownSnapshot["pr"],
  next: CrownSnapshot["pr"],
): CrownSnapshot["pr"] {
  if (!next) return prev;
  if (!prev || prev.number !== next.number) return next;
  return {
    number: next.number,
    state: next.state ?? prev.state,
    isDraft: next.isDraft ?? prev.isDraft,
    approvals: next.approvals ?? prev.approvals,
    conflicting: next.conflicting ?? prev.conflicting,
  };
}

type EventDraft = Omit<CrownEvent, "id">;

export function diffCrownSnapshots(
  prev: CrownSnapshot | null,
  next: CrownSnapshot,
  ctx: CrownDiffContext,
): CrownEvent[] {
  if (!prev || prev.scopeKey !== next.scopeKey) return [];
  const gitSuppressed = ctx.nowMs < ctx.suppressGitUntilMs;
  const drafts: EventDraft[] = [
    ...diffChecks(prev, next),
    ...diffPullRequest(prev, next, gitSuppressed),
    ...(gitSuppressed ? [] : diffBranch(prev, next)),
    ...diffDirectAgents(prev, next),
    ...diffWorkflows(prev, next),
    ...diffPlan(prev, next),
    ...turnEvents(next, ctx.turnOutcome),
    ...diffFiles(prev, next),
    ...diffNotes(prev, next),
  ];
  const events: CrownEvent[] = [];
  for (const draft of drafts) events.push({ ...draft, id: `${draft.dedupeKey}@${ctx.nowMs}` });
  return events;
}

function diffChecks(prev: CrownSnapshot, next: CrownSnapshot): EventDraft[] {
  const before = prev.checks;
  const after = next.checks;
  if (!before || !after) return [];
  const sameHead = before.headSha === after.headSha;
  const sha = after.headSha ?? "head";
  const base = { section: "checks", railKey: "checks", kind: "checks" } as const;

  const newFailures = after.failed.filter((name) => !before.failed.includes(name));
  const becameFailed = after.kind === "failed" && (before.kind !== "failed" || !sameHead);
  if (becameFailed || (after.kind === "failed" && newFailures.length > 0)) {
    const count = Math.max(1, after.failed.length);
    return [
      {
        ...base,
        tone: "danger",
        icon: "x",
        title: `${formatCount(count, "check")} failing`,
        ...(after.failed[0] ? { sub: after.failed[0] } : {}),
        loud: true,
        dedupeKey: `checks:failed:${sha}:${[...after.failed].toSorted().join(",")}`,
      },
    ];
  }
  if (sameHead && after.kind === "passed" && IN_FLIGHT_CHECK_KINDS.has(before.kind)) {
    const sub = next.pr ? `PR #${next.pr.number}` : after.refName;
    return [
      {
        ...base,
        tone: "success",
        icon: "check",
        title: "All checks passed",
        ...(sub ? { sub } : {}),
        loud: true,
        dedupeKey: `checks:passed:${sha}`,
      },
    ];
  }
  const inFlight = IN_FLIGHT_CHECK_KINDS.has(after.kind);
  if (!sameHead || (inFlight && !IN_FLIGHT_CHECK_KINDS.has(before.kind))) {
    return [
      {
        ...base,
        tone: "warning",
        icon: "check",
        title: inFlight ? "Checks started" : "Checks updated",
        loud: false,
        dedupeKey: `checks:started:${sha}`,
      },
    ];
  }
  return [];
}

function diffPullRequest(
  prev: CrownSnapshot,
  next: CrownSnapshot,
  gitSuppressed: boolean,
): EventDraft[] {
  const after = next.pr;
  if (!after) return [];
  const before = prev.pr;
  const n = after.number;
  const base = { section: "pr", railKey: "pr", kind: "pr", icon: "pr" } as const;

  if (!before || before.number !== n) {
    // A PR found after switching branches is not one that was just opened, and
    // a PR found while the lookup was still answering was there all along.
    if (gitSuppressed || prev.branch.refName !== next.branch.refName) return [];
    if (!before && !prev.prSettled) return [];
    return [
      {
        ...base,
        tone: "info",
        title: after.isDraft ? `Opened draft PR #${n}` : `Opened PR #${n}`,
        ...(next.branch.refName ? { sub: next.branch.refName } : {}),
        loud: true,
        dedupeKey: `pr:${n}:opened`,
      },
    ];
  }

  const events: EventDraft[] = [];
  // Every comparison below is between two known values.
  if (after.state === "merged" && before.state !== null && before.state !== "merged") {
    events.push({
      ...base,
      tone: "success",
      icon: "check",
      title: `PR #${n} merged`,
      loud: true,
      dedupeKey: `pr:${n}:merged`,
    });
  } else if (after.state === "closed" && before.state !== null && before.state !== "closed") {
    events.push({
      ...base,
      tone: "neutral",
      title: `PR #${n} closed`,
      loud: false,
      dedupeKey: `pr:${n}:closed`,
    });
  }
  if (after.state === "open") {
    if (before.isDraft === true && after.isDraft === false) {
      events.push({
        ...base,
        tone: "info",
        title: `PR #${n} ready for review`,
        loud: true,
        dedupeKey: `pr:${n}:ready`,
      });
    }
    if (
      before.approvals !== null &&
      after.approvals !== null &&
      after.approvals > before.approvals
    ) {
      events.push({
        ...base,
        tone: "success",
        icon: "check",
        title: `PR #${n} approved`,
        ...(after.approvals > 1 ? { sub: `${after.approvals} approvals` } : {}),
        loud: true,
        dedupeKey: `pr:${n}:approved:${after.approvals}`,
      });
    }
    if (before.conflicting === false && after.conflicting === true) {
      events.push({
        ...base,
        tone: "danger",
        icon: "x",
        title: `PR #${n} has conflicts`,
        loud: true,
        dedupeKey: `pr:${n}:conflicting`,
      });
    }
  }
  return events;
}

function diffBranch(prev: CrownSnapshot, next: CrownSnapshot): EventDraft[] {
  const before = prev.branch;
  const after = next.branch;
  if (!after.refName || before.refName !== after.refName) return [];
  if (before.ahead === null || before.behind === null) return [];
  if (after.ahead === null || after.behind === null) return [];
  const base = { section: "branch", railKey: "branch", kind: "branch" } as const;
  // Ahead counts repeat (commit 1, push, commit 1 again); the turn tells repeats apart.
  const scope = `branch:${after.refName}:${next.turn?.turnId ?? ""}`;
  if (after.ahead > before.ahead) {
    const count = after.ahead - before.ahead;
    return [
      {
        ...base,
        tone: "neutral",
        icon: "commit",
        title: formatCount(count, "new commit"),
        sub: after.refName,
        loud: true,
        dedupeKey: `${scope}:ahead:${before.ahead}->${after.ahead}`,
      },
    ];
  }
  if (before.ahead > 0 && after.ahead === 0 && after.behind === before.behind) {
    return [
      {
        ...base,
        tone: "info",
        icon: "upload",
        title: `Pushed ${formatCount(before.ahead, "commit")}`,
        sub: after.refName,
        loud: true,
        dedupeKey: `${scope}:pushed:${before.ahead}`,
      },
    ];
  }
  return [];
}

type SubagentTransition = "started" | "finished" | "failed";

/**
 * Direct agents: one that appears active started, one that completes from a
 * live state finished, one that fails needs review. Interrupted and cancelled
 * agents were stopped on purpose and never alert.
 */
function diffDirectAgents(prev: CrownSnapshot, next: CrownSnapshot): EventDraft[] {
  const transitions: Array<{ key: string; name: string; transition: SubagentTransition }> = [];
  for (const [key, agent] of Object.entries(next.agents.direct)) {
    const before = prev.agents.direct[key]?.status;
    if (before === agent.status) continue;
    if (before === undefined && isActiveSubagentStatus(agent.status)) {
      transitions.push({ key, name: agent.name, transition: "started" });
    } else if (
      agent.status === "completed" &&
      before !== undefined &&
      !isTerminalSubagentStatus(before)
    ) {
      transitions.push({ key, name: agent.name, transition: "finished" });
    } else if (agent.status === "failed" && before !== "interrupted") {
      transitions.push({ key, name: agent.name, transition: "failed" });
    }
  }
  if (transitions.length === 0) return [];

  const base = { section: "agents", railKey: "agents", kind: "subagent", icon: "bot" } as const;
  if (transitions.length >= CROWN_SUBAGENT_BURST_MIN) {
    const kinds = new Set(transitions.map((entry) => entry.transition));
    const [only] = kinds;
    const count = transitions.length;
    const title =
      kinds.size > 1 || !only
        ? `${count} subagent updates`
        : only === "started"
          ? `${count} subagents started`
          : only === "finished"
            ? `${count} subagents finished`
            : `${count} subagents need review`;
    return [
      {
        ...base,
        tone: kinds.has("failed") ? "danger" : "agent",
        title,
        sub: transitions.map((entry) => entry.name).join(", "),
        loud: true,
        dedupeKey: `subagents:${transitions
          .map((entry) => `${entry.key}:${entry.transition}`)
          .toSorted()
          .join("|")}`,
      },
    ];
  }
  const events: EventDraft[] = [];
  for (const { key, name, transition } of transitions) {
    events.push({
      ...base,
      tone: transition === "failed" ? "danger" : "agent",
      title:
        transition === "started"
          ? `${name} started`
          : transition === "finished"
            ? `${name} finished`
            : `${name} needs review`,
      loud: true,
      dedupeKey: `subagent:${key}:${transition}`,
    });
  }
  return events;
}

/**
 * Workflows alert per run, never per member: it started, it finished (with
 * how many members failed), members newly failed, or the coordinator failed on
 * its own. An interrupted or cancelled run was stopped on purpose.
 */
function diffWorkflows(prev: CrownSnapshot, next: CrownSnapshot): EventDraft[] {
  const base = {
    section: "agents",
    railKey: "agents",
    kind: "subagent",
    icon: "workflow",
  } as const;
  const events: EventDraft[] = [];
  for (const [id, after] of Object.entries(next.agents.workflows)) {
    const before = prev.agents.workflows[id];
    if (!before) {
      if (isActiveSubagentStatus(after.status)) {
        events.push({
          ...base,
          tone: "agent",
          title: `Workflow ${after.name} started`,
          ...(after.phaseCount > 0 ? { sub: formatCount(after.phaseCount, "phase") } : {}),
          loud: true,
          dedupeKey: `workflow:${id}:started`,
        });
      }
      continue;
    }
    if (after.status === "completed" && !isTerminalSubagentStatus(before.status)) {
      const failed = after.failedMemberIds.length;
      events.push({
        ...base,
        tone: failed > 0 ? "danger" : "agent",
        title: `${after.name} finished`,
        sub:
          failed > 0
            ? `${failed} of ${formatCount(after.memberCount, "agent")} failed`
            : formatCount(after.memberCount, "agent"),
        loud: true,
        dedupeKey: `workflow:${id}:finished`,
      });
      continue;
    }
    const newlyFailed = after.failedMemberIds.filter(
      (memberId) => !before.failedMemberIds.includes(memberId),
    );
    if (newlyFailed.length > 0) {
      events.push({
        ...base,
        tone: "danger",
        title: `${after.name}: ${after.failedMemberIds.length} failed`,
        ...(after.firstFailedName ? { sub: after.firstFailedName } : {}),
        loud: true,
        dedupeKey: `workflow:${id}:failed:${after.failedMemberIds.toSorted().join(",")}`,
      });
    } else if (
      after.status === "failed" &&
      after.failedMemberIds.length === 0 &&
      before.status !== "failed" &&
      before.status !== "interrupted"
    ) {
      events.push({
        ...base,
        tone: "danger",
        title: `${after.name} failed`,
        loud: true,
        dedupeKey: `workflow:${id}:failed`,
      });
    }
  }
  return events;
}

function diffPlan(prev: CrownSnapshot, next: CrownSnapshot): EventDraft[] {
  const before = prev.plan;
  const after = next.plan;
  if (!before || !after || before.turnId !== after.turnId) return [];
  const finished = after.completedSteps.filter((step) => !before.completedSteps.includes(step));
  const last = finished.at(-1);
  if (last === undefined) return [];
  return [
    {
      section: "plan",
      railKey: "plan",
      kind: "plan",
      icon: "sparkles",
      tone: "plan",
      title: finished.length === 1 ? `Finished “${last}”` : `Finished ${finished.length} steps`,
      sub: `${after.completedSteps.length}/${after.total}`,
      loud: false,
      dedupeKey: `plan:${after.turnId ?? "plan"}:${after.completedSteps.length}:${last}`,
    },
  ];
}

/** The alert for a watched turn ending; the tracker decides that it ended and how. */
function turnEvents(next: CrownSnapshot, outcome: TurnCompletionOutcome | null): EventDraft[] {
  const turn = next.turn;
  if (!turn || outcome === null) return [];
  const base = { section: "changes", railKey: "changes", kind: "turn", icon: "turn" } as const;
  if (outcome === "completed") {
    const elapsed =
      turn.startedAt && turn.completedAt
        ? formatElapsedDurationLabel(turn.startedAt, Date.parse(turn.completedAt))
        : null;
    return [
      {
        ...base,
        tone: "success",
        title: "Turn finished",
        ...(elapsed
          ? { sub: elapsed === "just now" ? "Took a few seconds" : `Took ${elapsed}` }
          : {}),
        loud: true,
        dedupeKey: `turn:${turn.turnId}:completed`,
      },
    ];
  }
  if (outcome === "failed") {
    return [
      {
        ...base,
        tone: "danger",
        icon: "x",
        title: "Turn failed",
        loud: true,
        dedupeKey: `turn:${turn.turnId}:error`,
      },
    ];
  }
  // An interrupted turn was stopped on purpose.
  return [];
}

function diffFiles(prev: CrownSnapshot, next: CrownSnapshot): EventDraft[] {
  if (next.fileCount <= prev.fileCount) return [];
  return [
    {
      section: "changes",
      railKey: "changes",
      kind: "changes",
      icon: "commit",
      tone: "neutral",
      title: `${formatCount(next.fileCount, "file")} changed`,
      loud: false,
      dedupeKey: `changes:${next.branch.refName ?? ""}:${next.fileCount}`,
    },
  ];
}

/**
 * A note that appears is "saved": loud when it came from elsewhere (another
 * device or client), only a ping for this client's own saves, which the pane
 * already shows. A first answer or a reload that hides notes never alerts.
 */
function diffNotes(prev: CrownSnapshot, next: CrownSnapshot): EventDraft[] {
  const before = prev.notes;
  const after = next.notes;
  if (!before || !after) return [];
  const base = { section: "notes", railKey: "notes", kind: "note", icon: "note" } as const;
  const own: string[] = [];
  const elsewhere: Array<{ id: string; summary: string }> = [];
  for (const [id, note] of Object.entries(after)) {
    if (id in before) continue;
    if (note.own) own.push(id);
    else elsewhere.push({ id, summary: note.summary });
  }
  const events: EventDraft[] = [];
  for (const id of own) {
    events.push({
      ...base,
      tone: "note",
      title: "Note saved",
      loud: false,
      dedupeKey: `note:${id}:own`,
      noteId: id,
    });
  }
  const [first] = elsewhere;
  if (!first) return events;
  if (elsewhere.length >= CROWN_SUBAGENT_BURST_MIN) {
    events.push({
      ...base,
      tone: "note",
      title: `${elsewhere.length} notes saved`,
      ...(first.summary ? { sub: first.summary } : {}),
      loud: true,
      dedupeKey: `notes:${elsewhere
        .map((note) => note.id)
        .toSorted()
        .join("|")}`,
      noteId: first.id,
    });
    return events;
  }
  for (const note of elsewhere) {
    events.push({
      ...base,
      tone: "note",
      title: "Note saved",
      ...(note.summary ? { sub: note.summary } : {}),
      loud: true,
      dedupeKey: `note:${note.id}`,
      noteId: note.id,
    });
  }
  return events;
}
