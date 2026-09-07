import { extractToolContentText, extractToolResultText } from "@ryco/shared/toolOutput";
import { isContextCompactionActivity } from "@ryco/shared/threadActivity";

import { isBackgroundTaskActivity } from "./subagentRuntime.ts";
import {
  ApprovalRequestId,
  CONTEXT_HANDOFF_ACTIVITY_KIND,
  isToolLifecycleItemType,
  type MessageId,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type OrchestrationProposedPlanId,
  ProviderDriverKind,
  type ToolLifecycleItemType,
  type UserInputQuestion,
  type ThreadId,
  type TurnId,
} from "@ryco/contracts";

import type {
  ChatMessage,
  ProposedPlan,
  SessionPhase,
  Thread,
  ThreadSession,
  TurnDiffFileChange,
  TurnDiffSummary,
} from "../threads/types.ts";
import {
  toContextHandoffTimelineEntry,
  type ContextHandoffTimelineEntry,
} from "./contextHandoff.ts";

export type ProviderPickerKind = ProviderDriverKind;

export const PROVIDER_OPTIONS: Array<{
  value: ProviderPickerKind;
  label: string;
  available: boolean;
  /** Shown on the model picker sidebar when relevant */
  pickerSidebarBadge?: "new" | "soon";
}> = [
  { value: ProviderDriverKind.make("codex"), label: "Codex", available: true },
  { value: ProviderDriverKind.make("claudeAgent"), label: "Claude", available: true },
  {
    value: ProviderDriverKind.make("copilot"),
    label: "GitHub Copilot",
    available: true,
  },
  {
    value: ProviderDriverKind.make("opencode"),
    label: "OpenCode",
    available: true,
    pickerSidebarBadge: "new",
  },
  {
    value: ProviderDriverKind.make("cursor"),
    label: "Cursor",
    available: true,
    pickerSidebarBadge: "new",
  },
  {
    value: ProviderDriverKind.make("grok"),
    label: "Grok",
    available: true,
    pickerSidebarBadge: "new",
  },
];

export interface WorkLogEntry {
  id: string;
  sequence?: number;
  createdAt: string;
  label: string;
  detail?: string;
  command?: string;
  rawCommand?: string;
  changedFiles?: ReadonlyArray<string>;
  changedFileStats?: ReadonlyArray<TurnDiffFileChange>;
  completed?: boolean;
  tone: "thinking" | "tool" | "info" | "error";
  toolTitle?: string;
  itemType?: ToolLifecycleItemType;
  requestKind?: PendingApproval["requestKind"];
  turnId?: TurnId | null;
  /** Full untruncated output text for the expanded panel. */
  output?: string;
  /** Process exit code when the activity reported one. */
  exitCode?: number;
  /**
   * When the tool call began. Sourced from the matching `tool.started` activity
   * (which is itself filtered out of the log), falling back to the first
   * lifecycle event folded into this entry. Absent when neither is available.
   */
  startedAt?: string;
  /** Timestamp of the newest lifecycle event folded into this entry. */
  lastActivityAt?: string;
  /** Grouping key for subagent lifecycle rows (one row per agent). */
  taskId?: string;
  /** Agent role (subagent_type) for labeled timeline rows. */
  agentRole?: string;
  /**
   * Present on agent-spawn CTA rows: one per workflow run or per-turn batch
   * of direct spawns. The row renders as a call-to-action ("Kicked off N
   * subagents") whose live status is derived from the agent panel model at
   * render time; clicking opens the Agents panel.
   */
  agentSpawn?: {
    /** Workflow coordinator taskId, or null for a direct-spawn batch. */
    workflowId: string | null;
    agentTaskIds: ReadonlyArray<string>;
  };
}

export interface ContextCompactionTimelineEntry {
  id: string;
  activityId: string;
  createdAt: string;
  label: string;
  turnId: TurnId | null;
}

interface DerivedWorkLogEntry extends WorkLogEntry {
  activityKind: OrchestrationThreadActivity["kind"];
  collapseKey?: string;
  toolCallId?: string;
  isWorkflowCoordinator?: boolean;
  /** Shell/monitor/plan tasks: ordinary work-log rows, never spawn CTAs. */
  isBackgroundTask?: boolean;
}

export interface PendingApproval {
  requestId: ApprovalRequestId;
  requestKind: "command" | "file-read" | "file-change";
  createdAt: string;
  detail?: string;
}

export interface PendingUserInput {
  requestId: ApprovalRequestId;
  createdAt: string;
  questions: ReadonlyArray<UserInputQuestion>;
}

export interface ActivePlanState {
  createdAt: string;
  turnId: TurnId | null;
  explanation?: string | null;
  steps: Array<{
    step: string;
    status: "pending" | "inProgress" | "completed";
  }>;
}

export interface ThreadActivityViewModel {
  workLogEntries: WorkLogEntry[];
  contextCompactionEntries: ContextCompactionTimelineEntry[];
  contextHandoffEntries: ContextHandoffTimelineEntry[];
  latestTurnHasToolActivity: boolean;
  pendingApprovals: PendingApproval[];
  pendingUserInputs: PendingUserInput[];
  activePlan: ActivePlanState | null;
}

export interface LatestProposedPlanState {
  id: OrchestrationProposedPlanId;
  createdAt: string;
  updatedAt: string;
  turnId: TurnId | null;
  planMarkdown: string;
  implementedAt: string | null;
  implementationThreadId: ThreadId | null;
}

export type TimelineEntry =
  | {
      id: string;
      kind: "message";
      createdAt: string;
      message: ChatMessage;
    }
  | {
      id: string;
      kind: "proposed-plan";
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      id: string;
      kind: "work";
      createdAt: string;
      entry: WorkLogEntry;
    }
  | {
      id: string;
      kind: "context-compaction";
      createdAt: string;
      marker: ContextCompactionTimelineEntry;
    }
  | {
      id: string;
      kind: "context-handoff";
      createdAt: string;
      marker: ContextHandoffTimelineEntry;
    };

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  if (seconds === 0) return `${minutes}m`;
  if (seconds === 60) return `${minutes + 1}m`;
  return `${minutes}m ${seconds}s`;
}

export function formatElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;
  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) {
    return null;
  }
  return formatDuration(endedAt - startedAt);
}

type LatestTurnTiming = Pick<OrchestrationLatestTurn, "turnId" | "startedAt" | "completedAt">;
type SessionActivityState = Pick<ThreadSession, "orchestrationStatus" | "activeTurnId">;

export function isLatestTurnSettled(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): boolean {
  if (!latestTurn?.startedAt) return false;
  if (!latestTurn.completedAt) return false;
  if (!session) return true;
  if (session.orchestrationStatus === "running") return false;
  return true;
}

/** The plan follow-up prompt is actionable only after work has settled in plan mode. */
export function isPlanFollowUpReady(input: {
  readonly interactionMode: string;
  readonly latestTurnSettled: boolean;
  readonly hasPendingUserInput: boolean;
  readonly hasActionableProposedPlan: boolean;
}): boolean {
  return (
    input.interactionMode === "plan" &&
    input.latestTurnSettled &&
    !input.hasPendingUserInput &&
    input.hasActionableProposedPlan
  );
}

export function deriveActiveWorkStartedAt(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
  sendStartedAt: string | null,
): string | null {
  const runningTurnId =
    session?.orchestrationStatus === "running" ? (session.activeTurnId ?? null) : null;
  if (runningTurnId !== null) {
    if (latestTurn?.turnId === runningTurnId) {
      return latestTurn.startedAt ?? sendStartedAt;
    }
    return sendStartedAt;
  }
  if (!isLatestTurnSettled(latestTurn, session)) {
    return latestTurn?.startedAt ?? sendStartedAt;
  }
  return sendStartedAt;
}

function requestKindFromRequestType(requestType: unknown): PendingApproval["requestKind"] | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
    case "dynamic_tool_call":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return null;
  }
}

function isStalePendingRequestFailureDetail(detail: string | undefined): boolean {
  const normalized = detail?.toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("stale pending approval request") ||
    normalized.includes("stale pending user-input request") ||
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending permission request") ||
    normalized.includes("unknown pending user-input request")
  );
}

function activityPayload(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  return activity.payload && typeof activity.payload === "object"
    ? (activity.payload as Record<string, unknown>)
    : null;
}

function requestIdFromPayload(payload: Record<string, unknown> | null): ApprovalRequestId | null {
  return payload && typeof payload.requestId === "string"
    ? ApprovalRequestId.make(payload.requestId)
    : null;
}

function detailFromPayload(payload: Record<string, unknown> | null): string | undefined {
  return payload && typeof payload.detail === "string" ? payload.detail : undefined;
}

function requestKindFromPayload(
  payload: Record<string, unknown> | null,
): PendingApproval["requestKind"] | null {
  if (
    payload &&
    (payload.requestKind === "command" ||
      payload.requestKind === "file-read" ||
      payload.requestKind === "file-change")
  ) {
    return payload.requestKind;
  }
  return payload ? requestKindFromRequestType(payload.requestType) : null;
}

function updatePendingApprovalState(
  openByRequestId: Map<ApprovalRequestId, PendingApproval>,
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown> | null,
) {
  if (
    activity.kind !== "approval.requested" &&
    activity.kind !== "approval.resolved" &&
    activity.kind !== "provider.approval.respond.failed"
  ) {
    return;
  }

  const requestId = requestIdFromPayload(payload);
  const requestKind = requestKindFromPayload(payload);
  const detail = detailFromPayload(payload);

  if (activity.kind === "approval.requested" && requestId && requestKind) {
    openByRequestId.set(requestId, {
      requestId,
      requestKind,
      createdAt: activity.createdAt,
      ...(detail ? { detail } : {}),
    });
    return;
  }

  if (activity.kind === "approval.resolved" && requestId) {
    openByRequestId.delete(requestId);
    return;
  }

  if (
    activity.kind === "provider.approval.respond.failed" &&
    requestId &&
    isStalePendingRequestFailureDetail(detail)
  ) {
    openByRequestId.delete(requestId);
  }
}

function pendingApprovalsFromState(
  openByRequestId: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): PendingApproval[] {
  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingApproval[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingApproval>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    updatePendingApprovalState(openByRequestId, activity, activityPayload(activity));
  }

  return pendingApprovalsFromState(openByRequestId);
}

function parseUserInputQuestions(
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> | null {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return null;
  }
  const parsed = questions
    .map<UserInputQuestion | null>((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const question = entry as Record<string, unknown>;
      if (
        typeof question.id !== "string" ||
        typeof question.header !== "string" ||
        typeof question.question !== "string" ||
        !Array.isArray(question.options)
      ) {
        return null;
      }
      const options = question.options
        .map<UserInputQuestion["options"][number] | null>((option) => {
          if (!option || typeof option !== "object") return null;
          const optionRecord = option as Record<string, unknown>;
          if (
            typeof optionRecord.label !== "string" ||
            typeof optionRecord.description !== "string"
          ) {
            return null;
          }
          return {
            label: optionRecord.label,
            description: optionRecord.description,
          };
        })
        .filter((option): option is UserInputQuestion["options"][number] => option !== null);
      if (options.length === 0) {
        return null;
      }
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
        multiSelect: question.multiSelect === true,
      };
    })
    .filter((question): question is UserInputQuestion => question !== null);
  return parsed.length > 0 ? parsed : null;
}

export function derivePendingUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingUserInput[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingUserInput>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    updatePendingUserInputState(openByRequestId, activity, activityPayload(activity));
  }

  return pendingUserInputsFromState(openByRequestId);
}

function updatePendingUserInputState(
  openByRequestId: Map<ApprovalRequestId, PendingUserInput>,
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown> | null,
) {
  if (
    activity.kind !== "user-input.requested" &&
    activity.kind !== "user-input.resolved" &&
    activity.kind !== "provider.user-input.respond.failed"
  ) {
    return;
  }

  const requestId = requestIdFromPayload(payload);
  const detail = detailFromPayload(payload);

  if (activity.kind === "user-input.requested" && requestId) {
    const questions = parseUserInputQuestions(payload);
    if (!questions) {
      return;
    }
    openByRequestId.set(requestId, {
      requestId,
      createdAt: activity.createdAt,
      questions,
    });
    return;
  }

  if (activity.kind === "user-input.resolved" && requestId) {
    openByRequestId.delete(requestId);
    return;
  }

  if (
    activity.kind === "provider.user-input.respond.failed" &&
    requestId &&
    isStalePendingRequestFailureDetail(detail)
  ) {
    openByRequestId.delete(requestId);
  }
}

function pendingUserInputsFromState(
  openByRequestId: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): PendingUserInput[] {
  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function toActivePlanState(activity: OrchestrationThreadActivity | null): ActivePlanState | null {
  if (!activity) {
    return null;
  }
  const payload = activityPayload(activity);
  const rawPlan = payload?.plan;
  if (!Array.isArray(rawPlan)) {
    return null;
  }
  const steps = rawPlan
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      if (typeof record.step !== "string") {
        return null;
      }
      const status =
        record.status === "completed" || record.status === "inProgress" ? record.status : "pending";
      return {
        step: record.step,
        status,
      };
    })
    .filter(
      (
        step,
      ): step is {
        step: string;
        status: "pending" | "inProgress" | "completed";
      } => step !== null,
    );
  if (steps.length === 0) {
    return null;
  }
  return {
    createdAt: activity.createdAt,
    turnId: activity.turnId,
    ...(payload && "explanation" in payload
      ? { explanation: payload.explanation as string | null }
      : {}),
    steps,
  };
}

export function deriveActivePlanState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): ActivePlanState | null {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  let latestPlanActivity: OrchestrationThreadActivity | null = null;
  let latestPlanActivityForTurn: OrchestrationThreadActivity | null = null;

  for (const activity of ordered) {
    if (activity.kind !== "turn.plan.updated") {
      continue;
    }
    latestPlanActivity = activity;
    if (latestTurnId && activity.turnId === latestTurnId) {
      latestPlanActivityForTurn = activity;
    }
  }

  // Prefer plan from the current turn; fall back to the most recent plan from any turn
  // so that TodoWrite tasks persist across follow-up messages.
  return toActivePlanState(latestPlanActivityForTurn ?? latestPlanActivity);
}

export function findLatestProposedPlan(
  proposedPlans: ReadonlyArray<ProposedPlan>,
  latestTurnId: TurnId | string | null | undefined,
): LatestProposedPlanState | null {
  if (latestTurnId) {
    const matchingTurnPlan = [...proposedPlans]
      .filter((proposedPlan) => proposedPlan.turnId === latestTurnId)
      .toSorted(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      )
      .at(-1);
    if (matchingTurnPlan) {
      return toLatestProposedPlanState(matchingTurnPlan);
    }
  }

  const latestPlan = [...proposedPlans]
    .toSorted(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    )
    .at(-1);
  if (!latestPlan) {
    return null;
  }

  return toLatestProposedPlanState(latestPlan);
}

export function findSidebarProposedPlan(input: {
  threads: ReadonlyArray<Pick<Thread, "id" | "proposedPlans">>;
  latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "sourceProposedPlan"> | null;
  latestTurnSettled: boolean;
  threadId: ThreadId | string | null | undefined;
}): LatestProposedPlanState | null {
  const activeThreadPlans =
    input.threads.find((thread) => thread.id === input.threadId)?.proposedPlans ?? [];

  if (!input.latestTurnSettled) {
    const sourceProposedPlan = input.latestTurn?.sourceProposedPlan;
    if (sourceProposedPlan) {
      const sourcePlan = input.threads
        .find((thread) => thread.id === sourceProposedPlan.threadId)
        ?.proposedPlans.find((plan) => plan.id === sourceProposedPlan.planId);
      if (sourcePlan) {
        return toLatestProposedPlanState(sourcePlan);
      }
    }
  }

  return findLatestProposedPlan(activeThreadPlans, input.latestTurn?.turnId ?? null);
}

export function hasActionableProposedPlan(
  proposedPlan: LatestProposedPlanState | Pick<ProposedPlan, "implementedAt"> | null,
): boolean {
  return proposedPlan !== null && proposedPlan.implementedAt === null;
}

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
  options?: { readonly agentTimeline?: boolean },
): WorkLogEntry[] {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  // `tool.started` never becomes a row of its own, but it carries the only
  // authoritative start time for a tool call. Index it first so the surviving
  // lifecycle entries can report how long their call actually took.
  const startedAtByToolCallId = collectToolStartTimestamps(ordered);
  const firstSequenceByToolId = new Map<string, number>();
  if (options?.agentTimeline)
    for (const activity of ordered) {
      const id = extractToolCallId(asRecord(activity.payload));
      if (id && activity.sequence !== undefined && !firstSequenceByToolId.has(id))
        firstSequenceByToolId.set(id, activity.sequence);
    }
  const entries: DerivedWorkLogEntry[] = [];
  for (const activity of ordered) {
    const visibleActivity =
      options?.agentTimeline && activity.kind === "tool.started"
        ? { ...activity, kind: "tool.updated" }
        : activity;
    if (shouldIncludeActivityInWorkLog(visibleActivity, latestTurnId, options?.agentTimeline)) {
      const entry = toDerivedWorkLogEntry(visibleActivity, startedAtByToolCallId);
      const sequence =
        (entry.toolCallId ? firstSequenceByToolId.get(entry.toolCallId) : undefined) ??
        activity.sequence;
      if (options?.agentTimeline && sequence !== undefined) entry.sequence = sequence;
      entries.push(entry);
    }
  }
  if (options?.agentTimeline) {
    const byCall = new Map<string, number>();
    const merged: DerivedWorkLogEntry[] = [];
    for (const entry of entries) {
      const key = entry.toolCallId ? `${entry.turnId ?? ""}:${entry.toolCallId}` : null;
      const index = key ? byCall.get(key) : undefined;
      if (index !== undefined) {
        const previous = merged[index]!;
        if (!previous.completed || entry.completed)
          merged[index] = { ...mergeDerivedWorkLogEntries(previous, entry), id: previous.id };
      } else {
        if (key) byCall.set(key, merged.length);
        merged.push(entry);
      }
    }
    return toWorkLogEntries(merged);
  }
  return toWorkLogEntries(entries);
}

function collectToolStartTimestamps(
  ordered: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyMap<string, string> {
  const startedAtByToolCallId = new Map<string, string>();
  for (const activity of ordered) {
    if (activity.kind !== "tool.started") {
      continue;
    }
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const toolCallId = extractToolCallId(payload);
    // Activities are already ordered, so the first sighting is the earliest.
    if (toolCallId && !startedAtByToolCallId.has(toolCallId)) {
      startedAtByToolCallId.set(toolCallId, activity.createdAt);
    }
  }
  return startedAtByToolCallId;
}

/**
 * Quiet-timeline guarantee: the work log carries the parent's narrative plus
 * at most one row per agent-spawn batch. Everything an agent does internally
 * lives in the Agents surface:
 * - timelineBypass rows (Codex children, workflow members) never render here;
 * - tool rows attributed to an owning agent (payload.agentId) are re-homed;
 * - task.progress ticks collapse into one row per batch;
 * - task.updated / tool.progress are fold input only (not narrative).
 * Unattributed rows always stay: over-hiding loses the only terminal signal.
 */
function isAgentTaskRowPayload(
  activity: OrchestrationThreadActivity,
): Record<string, unknown> | null {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  if (!payload || typeof payload.taskId !== "string") {
    return null;
  }
  return payload;
}

/** Agent (non-background) task.started rows seed spawn CTA batches. */
function isAgentTaskStartedActivity(activity: OrchestrationThreadActivity): boolean {
  const payload = isAgentTaskRowPayload(activity);
  return payload !== null && !isBackgroundTaskActivity(payload);
}

/** Agent-stamped task lifecycle rows: exempt from the latest-turn filter so a
 * batch's CTA anchor and cross-turn completions survive turn settlement. */
function isAgentTaskLifecycleActivity(activity: OrchestrationThreadActivity): boolean {
  if (
    activity.kind !== "task.started" &&
    activity.kind !== "task.progress" &&
    activity.kind !== "task.completed"
  ) {
    return false;
  }
  const payload = isAgentTaskRowPayload(activity);
  return payload !== null && !isBackgroundTaskActivity(payload);
}

function isAgentInternalActivity(activity: OrchestrationThreadActivity): boolean {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  if (!payload) {
    return false;
  }
  const isTaskRow =
    activity.kind === "task.started" ||
    activity.kind === "task.progress" ||
    activity.kind === "task.updated" ||
    activity.kind === "task.completed";
  // Task rows classify by the server stamp: a subagent's own background
  // shell (agentId + "background") is agent-internal, but a nested AGENT
  // (agentId + "agent") stays visible so its rows can anchor a spawn CTA.
  // Bypassed agent lifecycle rows also pass — collapse folds every such
  // row into its batch's single CTA row, which is how Codex children
  // (whose rows are ALL bypassed) get an anchor at the spawn point.
  if (isTaskRow) {
    const ownedByAgent = typeof payload.agentId === "string" && payload.agentId.trim().length > 0;
    if (ownedByAgent || payload.timelineBypass === true) {
      const isAgentTaskRow =
        activity.kind !== "task.updated" &&
        typeof payload.taskId === "string" &&
        !isBackgroundTaskActivity(payload);
      return !isAgentTaskRow;
    }
    return false;
  }
  if (payload.timelineBypass === true) {
    return true;
  }
  // Non-task rows (attributed tool activity) owned by an agent are internal.
  return typeof payload.agentId === "string" && payload.agentId.trim().length > 0;
}

function shouldIncludeActivityInWorkLog(
  activity: OrchestrationThreadActivity,
  latestTurnId: TurnId | undefined,
  agentTimeline = false,
): boolean {
  if (
    latestTurnId &&
    activity.turnId !== latestTurnId &&
    // Agent task rows carry the true spawn turn and batch by it: a CTA
    // anchored in turn N must survive turn N+1 starting, and Claude
    // background completions arrive under later synthetic turns.
    !isAgentTaskLifecycleActivity(activity)
  ) {
    return false;
  }
  if (activity.kind === "task.started") {
    // Agent task.started rows are CTA seeds: they carry the true spawn
    // turn, which is the batch key. They collapse into the batch's single
    // CTA row, never render standalone.
    return isAgentTaskStartedActivity(activity);
  }
  if (activity.kind === "task.updated" || activity.kind === "tool.progress") {
    // Fold input only (status patches and heartbeats are not narrative).
    return false;
  }
  if (!agentTimeline && isAgentInternalActivity(activity)) {
    return false;
  }
  return (
    activity.kind !== "tool.started" &&
    activity.kind !== "agent.message" &&
    activity.kind !== "context-window.updated" &&
    activity.kind !== CONTEXT_HANDOFF_ACTIVITY_KIND &&
    !isContextCompactionActivity(activity) &&
    activity.summary !== "Checkpoint captured" &&
    !isPlanBoundaryToolActivity(activity)
  );
}

function toWorkLogEntries(entries: ReadonlyArray<DerivedWorkLogEntry>): WorkLogEntry[] {
  return collapseDerivedWorkLogEntries(entries).map(
    ({ activityKind: _activityKind, collapseKey: _collapseKey, ...entry }) => entry,
  );
}

function isPlanBoundaryToolActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") {
    return false;
  }

  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return typeof payload?.detail === "string" && payload.detail.startsWith("ExitPlanMode:");
}

function toDerivedWorkLogEntry(
  activity: OrchestrationThreadActivity,
  startedAtByToolCallId: ReadonlyMap<string, string>,
): DerivedWorkLogEntry {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const commandPreview = extractToolCommand(payload);
  const changedFiles = extractChangedFiles(payload);
  const changedFileStats = extractChangedFileStats(payload);
  const title = extractToolTitle(payload);
  const isTaskActivity =
    activity.kind === "task.started" ||
    activity.kind === "task.progress" ||
    activity.kind === "task.completed";
  const taskSummary =
    isTaskActivity && typeof payload?.summary === "string" && payload.summary.length > 0
      ? payload.summary
      : null;
  const taskDetailAsLabel =
    isTaskActivity &&
    !taskSummary &&
    typeof payload?.detail === "string" &&
    payload.detail.length > 0
      ? payload.detail
      : null;
  const taskLabel = taskSummary || taskDetailAsLabel;
  const detail = isTaskActivity
    ? !taskDetailAsLabel &&
      payload &&
      typeof payload.detail === "string" &&
      payload.detail.length > 0
      ? stripTrailingExitCode(payload.detail).output
      : null
    : extractToolDetail(payload, title ?? activity.summary);
  const toolCallId = isTaskActivity ? null : extractToolCallId(payload);
  const entry: DerivedWorkLogEntry = {
    id: activity.id,
    createdAt: activity.createdAt,
    label: taskLabel || activity.summary,
    tone:
      activity.kind === "task.progress"
        ? "thinking"
        : activity.tone === "approval"
          ? "info"
          : activity.tone,
    activityKind: activity.kind,
  };
  const itemType = extractWorkLogItemType(payload);
  const requestKind = extractWorkLogRequestKind(payload);
  const fullOutput = extractToolFullOutput(payload);
  const exitCode = extractToolExitCode(payload);
  if (detail) {
    entry.detail = detail;
  }
  if (commandPreview.command) {
    entry.command = commandPreview.command;
  }
  if (commandPreview.rawCommand) {
    entry.rawCommand = commandPreview.rawCommand;
  }
  if (changedFiles.length > 0) {
    entry.changedFiles = changedFiles;
  }
  if (changedFileStats.length > 0) {
    entry.changedFileStats = changedFileStats;
  }
  if (title) {
    entry.toolTitle = title;
  }
  if (itemType) {
    entry.itemType = itemType;
  }
  if (requestKind) {
    entry.requestKind = requestKind;
  }
  if (toolCallId) {
    entry.toolCallId = toolCallId;
    const startedAt = startedAtByToolCallId.get(toolCallId);
    if (startedAt) {
      entry.startedAt = startedAt;
    }
  }
  entry.lastActivityAt = activity.createdAt;
  if (fullOutput) {
    entry.output = fullOutput;
  }
  if (exitCode !== null) {
    entry.exitCode = exitCode;
  }
  if (activity.turnId !== null) {
    entry.turnId = activity.turnId;
  }
  if (activity.kind === "tool.completed" || activity.kind === "task.completed") {
    entry.completed = true;
  }
  if (isTaskActivity && typeof payload?.taskId === "string" && payload.taskId.length > 0) {
    entry.taskId = payload.taskId;
  }
  if (isTaskActivity && typeof payload?.role === "string" && payload.role.length > 0) {
    entry.agentRole = payload.role;
  }
  if (
    isTaskActivity &&
    (payload?.taskType === "local_workflow" ||
      (typeof payload?.workflowName === "string" && payload.workflowName.length > 0))
  ) {
    entry.isWorkflowCoordinator = true;
  }
  if (isTaskActivity && payload && isBackgroundTaskActivity(payload)) {
    entry.isBackgroundTask = true;
  }
  const collapseKey = deriveToolLifecycleCollapseKey(entry);
  if (collapseKey) {
    entry.collapseKey = collapseKey;
  }
  return entry;
}

/**
 * Spawn-group key for a subagent lifecycle row. Workflow members and their
 * coordinator share the coordinator's group; direct spawns batch per turn.
 * One CTA row per group: "Kicked off N subagents".
 */
function agentSpawnGroupKey(entry: DerivedWorkLogEntry): string {
  const taskId = entry.taskId ?? "";
  const workflowSlot = taskId.indexOf(":wf:");
  if (workflowSlot !== -1) {
    return `wf:${taskId.slice(0, workflowSlot)}`;
  }
  if (entry.agentSpawn?.workflowId) {
    return `wf:${entry.agentSpawn.workflowId}`;
  }
  if (entry.isWorkflowCoordinator) {
    return `wf:${taskId}`;
  }
  // No turn id means no batch signal at all: fall back to one group per
  // task. Unrelated turn-less spawns (separate fleets whose rows lost their
  // turn) must not collapse into one immortal "direct:no-turn" CTA
  // accumulating every agent the thread ever ran. Adapters stamp spawn
  // turns (Codex spawnTurnId; Claude rows ride real turns), so this path
  // is defensive.
  return entry.turnId ? `direct:${entry.turnId}` : `direct:task:${taskId}`;
}

function collapseDerivedWorkLogEntries(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[] {
  const collapsed: DerivedWorkLogEntry[] = [];
  // Subagent rows collapse by spawn group, not adjacency: a workflow run (or
  // a turn's batch of direct spawns) is ONE narrative event in the chat — a
  // CTA row that opens the Agents panel — no matter how many agents it
  // contains or how their progress rows interleave (quiet-timeline
  // guarantee).
  const spawnRowIndex = new Map<string, number>();
  // Batch membership is decided once, at the FIRST row seen for a taskId.
  // Claude background subagents settle between turns, so their completion
  // rows carry fresh synthetic turn ids (or none) — keying each row by its
  // own turn would splinter one batch into a stream of "Kicked off N
  // subagents" rows.
  const groupKeyByTaskId = new Map<string, string>();
  for (const entry of entries) {
    const isTaskRow =
      entry.taskId !== undefined &&
      !entry.isBackgroundTask &&
      (entry.activityKind === "task.started" ||
        entry.activityKind === "task.progress" ||
        entry.activityKind === "task.completed");
    if (isTaskRow && entry.taskId !== undefined) {
      const rememberedKey = groupKeyByTaskId.get(entry.taskId);
      const groupKey = rememberedKey ?? agentSpawnGroupKey(entry);
      if (rememberedKey === undefined) {
        groupKeyByTaskId.set(entry.taskId, groupKey);
      }
      const workflowId = groupKey.startsWith("wf:") ? groupKey.slice(3) : null;
      const existingIndex = spawnRowIndex.get(groupKey);
      if (existingIndex !== undefined) {
        const existing = collapsed[existingIndex]!;
        const agentTaskIds = existing.agentSpawn?.agentTaskIds.includes(entry.taskId)
          ? existing.agentSpawn.agentTaskIds
          : [...(existing.agentSpawn?.agentTaskIds ?? []), entry.taskId];
        collapsed[existingIndex] = {
          ...mergeDerivedWorkLogEntries(existing, entry),
          // The CTA row keeps the group's ANCHOR identity, not the last
          // agent's: id/createdAt/turnId stay pinned to the spawn point so
          // the row renders where the run launched instead of drifting to
          // the newest progress tick, and the stable id keeps React
          // state/virtualization sane. turnId pins unconditionally — a
          // turn-less anchor must stay turn-less instead of adopting a
          // later completion's synthetic turn and joining its fold group.
          id: existing.id,
          createdAt: existing.createdAt,
          turnId: existing.turnId ?? null,
          ...(existing.taskId !== undefined ? { taskId: existing.taskId } : {}),
          label: existing.label,
          agentSpawn: { workflowId, agentTaskIds },
        };
        continue;
      }
      spawnRowIndex.set(groupKey, collapsed.length);
      collapsed.push({
        ...entry,
        agentSpawn: { workflowId, agentTaskIds: [entry.taskId] },
      });
      continue;
    }
    const previous = collapsed.at(-1);
    if (previous && shouldCollapseToolLifecycleEntries(previous, entry)) {
      collapsed[collapsed.length - 1] = mergeDerivedWorkLogEntries(previous, entry);
      continue;
    }
    collapsed.push(entry);
  }
  return collapsed;
}

function shouldCollapseToolLifecycleEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): boolean {
  if (previous.activityKind !== "tool.updated" && previous.activityKind !== "tool.completed") {
    return false;
  }
  if (next.activityKind !== "tool.updated" && next.activityKind !== "tool.completed") {
    return false;
  }
  if (previous.activityKind === "tool.completed") {
    return false;
  }
  if (previous.collapseKey !== undefined && previous.collapseKey === next.collapseKey) {
    return true;
  }
  return (
    previous.toolCallId !== undefined &&
    next.toolCallId === undefined &&
    previous.itemType === next.itemType &&
    normalizeCompactToolLabel(previous.toolTitle ?? previous.label) ===
      normalizeCompactToolLabel(next.toolTitle ?? next.label)
  );
}

function mergeDerivedWorkLogEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): DerivedWorkLogEntry {
  const changedFiles = mergeChangedFiles(previous.changedFiles, next.changedFiles);
  const changedFileStats = mergeChangedFileStats(previous.changedFileStats, next.changedFileStats);
  const detail = next.detail ?? previous.detail;
  const command = next.command ?? previous.command;
  const rawCommand = next.rawCommand ?? previous.rawCommand;
  const toolTitle = next.toolTitle ?? previous.toolTitle;
  const itemType = next.itemType ?? previous.itemType;
  const requestKind = next.requestKind ?? previous.requestKind;
  const collapseKey = next.collapseKey ?? previous.collapseKey;
  const toolCallId = next.toolCallId ?? previous.toolCallId;
  const output = next.output ?? previous.output;
  const exitCode = next.exitCode ?? previous.exitCode;
  // `previous` is the earlier lifecycle event, so its own timestamp stands in as
  // the start when no `tool.started` was recorded for this call.
  const startedAt = previous.startedAt ?? next.startedAt ?? previous.createdAt;
  const lastActivityAt = next.lastActivityAt ?? next.createdAt;
  return {
    ...previous,
    ...next,
    startedAt,
    lastActivityAt,
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(rawCommand ? { rawCommand } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(changedFileStats.length > 0 ? { changedFileStats } : {}),
    ...(toolTitle ? { toolTitle } : {}),
    ...(itemType ? { itemType } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(collapseKey ? { collapseKey } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(output ? { output } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}

function mergeChangedFiles(
  previous: ReadonlyArray<string> | undefined,
  next: ReadonlyArray<string> | undefined,
): string[] {
  const merged = [...(previous ?? []), ...(next ?? [])];
  if (merged.length === 0) {
    return [];
  }
  return [...new Set(merged)];
}

function mergeChangedFileStats(
  previous: ReadonlyArray<TurnDiffFileChange> | undefined,
  next: ReadonlyArray<TurnDiffFileChange> | undefined,
): TurnDiffFileChange[] {
  const byPath = new Map<string, TurnDiffFileChange>();
  for (const entry of [...(previous ?? []), ...(next ?? [])]) {
    const existing = byPath.get(entry.path);
    byPath.set(entry.path, {
      path: entry.path,
      kind: entry.kind ?? existing?.kind,
      additions: entry.additions ?? existing?.additions,
      deletions: entry.deletions ?? existing?.deletions,
    });
  }
  return Array.from(byPath.values());
}

function deriveToolLifecycleCollapseKey(entry: DerivedWorkLogEntry): string | undefined {
  // Subagent lifecycle rows collapse by agent identity: one row per agent,
  // progress ticks fold into it, the terminal row wins the label.
  if (
    entry.taskId &&
    (entry.activityKind === "task.progress" || entry.activityKind === "task.completed")
  ) {
    return `task${entry.taskId}`;
  }
  if (entry.activityKind !== "tool.updated" && entry.activityKind !== "tool.completed") {
    return undefined;
  }
  if (entry.toolCallId) {
    return `tool:${entry.toolCallId}`;
  }
  const normalizedLabel = normalizeCompactToolLabel(entry.toolTitle ?? entry.label);
  const detail = entry.detail?.trim() ?? "";
  const itemType = entry.itemType ?? "";
  if (normalizedLabel.length === 0 && detail.length === 0 && itemType.length === 0) {
    return undefined;
  }
  return [itemType, normalizedLabel, detail].join("\u001f");
}

function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

function toLatestProposedPlanState(proposedPlan: ProposedPlan): LatestProposedPlanState {
  return {
    id: proposedPlan.id,
    createdAt: proposedPlan.createdAt,
    updatedAt: proposedPlan.updatedAt,
    turnId: proposedPlan.turnId,
    planMarkdown: proposedPlan.planMarkdown,
    implementedAt: proposedPlan.implementedAt,
    implementationThreadId: proposedPlan.implementationThreadId,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function trimMatchingOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    const unquoted = trimmed.slice(1, -1).trim();
    return unquoted.length > 0 ? unquoted : trimmed;
  }
  return trimmed;
}

function executableBasename(value: string): string | null {
  const trimmed = trimMatchingOuterQuotes(value);
  if (trimmed.length === 0) {
    return null;
  }
  const normalized = trimmed.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const last = segments.at(-1)?.trim() ?? "";
  return last.length > 0 ? last.toLowerCase() : null;
}

function splitExecutableAndRest(value: string): { executable: string; rest: string } | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed.charAt(0);
    const closeIndex = trimmed.indexOf(quote, 1);
    if (closeIndex <= 0) {
      return null;
    }
    return {
      executable: trimmed.slice(0, closeIndex + 1),
      rest: trimmed.slice(closeIndex + 1).trim(),
    };
  }

  const firstWhitespace = trimmed.search(/\s/);
  if (firstWhitespace < 0) {
    return {
      executable: trimmed,
      rest: "",
    };
  }

  return {
    executable: trimmed.slice(0, firstWhitespace),
    rest: trimmed.slice(firstWhitespace).trim(),
  };
}

const SHELL_WRAPPER_SPECS = [
  {
    executables: ["pwsh", "pwsh.exe", "powershell", "powershell.exe"],
    wrapperFlagPattern: /(?:^|\s)-command\s+/i,
  },
  {
    executables: ["cmd", "cmd.exe"],
    wrapperFlagPattern: /(?:^|\s)\/c\s+/i,
  },
  {
    executables: ["bash", "sh", "zsh"],
    wrapperFlagPattern: /(?:^|\s)-(?:l)?c\s+/i,
  },
] as const;

function findShellWrapperSpec(shell: string) {
  return SHELL_WRAPPER_SPECS.find((spec) =>
    (spec.executables as ReadonlyArray<string>).includes(shell),
  );
}

function unwrapCommandRemainder(value: string, wrapperFlagPattern: RegExp): string | null {
  const match = wrapperFlagPattern.exec(value);
  if (!match) {
    return null;
  }

  const command = value.slice(match.index + match[0].length).trim();
  if (command.length === 0) {
    return null;
  }

  const unwrapped = trimMatchingOuterQuotes(command);
  return unwrapped.length > 0 ? unwrapped : null;
}

function unwrapKnownShellCommandWrapper(value: string): string {
  const split = splitExecutableAndRest(value);
  if (!split || split.rest.length === 0) {
    return value;
  }

  const shell = executableBasename(split.executable);
  if (!shell) {
    return value;
  }

  const spec = findShellWrapperSpec(shell);
  if (!spec) {
    return value;
  }

  return unwrapCommandRemainder(split.rest, spec.wrapperFlagPattern) ?? value;
}

function formatCommandArrayPart(value: string): string {
  return /[\s"'`]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function formatCommandValue(value: unknown): string | null {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== null);
  if (parts.length === 0) {
    return null;
  }
  return parts.map((part) => formatCommandArrayPart(part)).join(" ");
}

function normalizeCommandValue(value: unknown): string | null {
  const formatted = formatCommandValue(value);
  return formatted ? unwrapKnownShellCommandWrapper(formatted) : null;
}

function toRawToolCommand(value: unknown, normalizedCommand: string | null): string | null {
  const formatted = formatCommandValue(value);
  if (!formatted || normalizedCommand === null) {
    return null;
  }
  return formatted === normalizedCommand ? null : formatted;
}

function extractToolCommand(payload: Record<string, unknown> | null): {
  command: string | null;
  rawCommand: string | null;
} {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const itemInput = asRecord(item?.input);
  const itemType = asTrimmedString(payload?.itemType);
  const detail = asTrimmedString(payload?.detail);
  const candidates: unknown[] = [
    item?.command,
    itemInput?.command,
    itemResult?.command,
    data?.command,
    asRecord(data?.input)?.command,
    asRecord(data?.rawInput)?.command,
    asRecord(asRecord(data?.state)?.input)?.command,
    itemType === "command_execution" && detail ? stripTrailingExitCode(detail).output : null,
  ];

  for (const candidate of candidates) {
    const command = normalizeCommandValue(candidate);
    if (!command) {
      continue;
    }
    return {
      command,
      rawCommand: toRawToolCommand(candidate, command),
    };
  }

  return {
    command: null,
    rawCommand: null,
  };
}

function extractToolTitle(payload: Record<string, unknown> | null): string | null {
  return asTrimmedString(payload?.title);
}

function extractToolCallId(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  return asTrimmedString(data?.toolCallId) ?? asTrimmedString(payload?.providerItemId);
}

function normalizeInlinePreview(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateInlinePreview(value: string, maxLength = 84): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function normalizePreviewForComparison(value: string | null | undefined): string | null {
  const normalized = asTrimmedString(value);
  if (!normalized) {
    return null;
  }
  return normalizeCompactToolLabel(normalizeInlinePreview(normalized)).toLowerCase();
}

function summarizeToolTextOutput(value: string): string | null {
  const lines = value
    .split(/\r?\n/u)
    .map((line) => normalizeInlinePreview(line))
    .filter((line) => line.length > 0);
  const firstLine = lines.find((line) => line !== "```");
  if (firstLine) {
    return truncateInlinePreview(firstLine);
  }
  if (lines.length > 1) {
    return `${lines.length.toLocaleString()} lines`;
  }
  return null;
}

function summarizeToolRawOutput(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const rawOutput = asRecord(data?.rawOutput);
  if (!rawOutput) {
    return null;
  }

  const totalFiles = asNumber(rawOutput.totalFiles);
  if (totalFiles !== null) {
    const suffix = rawOutput.truncated === true ? "+" : "";
    return `${totalFiles.toLocaleString()} file${totalFiles === 1 ? "" : "s"}${suffix}`;
  }

  const content = asTrimmedString(rawOutput.content);
  if (content) {
    return summarizeToolTextOutput(content);
  }

  const stdout = asTrimmedString(rawOutput.stdout);
  if (stdout) {
    return summarizeToolTextOutput(stdout);
  }

  return null;
}

function isCommandToolDetail(payload: Record<string, unknown> | null, heading: string): boolean {
  const data = asRecord(payload?.data);
  const kind = asTrimmedString(data?.kind)?.toLowerCase();
  const title = asTrimmedString(payload?.title ?? heading)?.toLowerCase();
  return (
    extractWorkLogItemType(payload) === "command_execution" ||
    kind === "execute" ||
    title === "terminal" ||
    title === "ran command"
  );
}

function extractToolDetail(
  payload: Record<string, unknown> | null,
  heading: string,
): string | null {
  const rawDetail = asTrimmedString(payload?.detail);
  const detail = rawDetail ? stripTrailingExitCode(rawDetail).output : null;
  const normalizedHeading = normalizePreviewForComparison(heading);
  const normalizedDetail = normalizePreviewForComparison(detail);

  if (detail && normalizedHeading !== normalizedDetail) {
    return detail;
  }

  if (isCommandToolDetail(payload, heading)) {
    return null;
  }

  const rawOutputSummary = summarizeToolRawOutput(payload);
  if (rawOutputSummary) {
    const normalizedRawOutputSummary = normalizePreviewForComparison(rawOutputSummary);
    if (normalizedRawOutputSummary !== normalizedHeading) {
      return rawOutputSummary;
    }
  }

  return null;
}

function extractTextFromContentArray(value: unknown): string | null {
  return extractToolContentText(value) ?? null;
}

function extractCodexItemOutput(item: Record<string, unknown> | null): string | null {
  if (!item) {
    return null;
  }
  const itemType = asTrimmedString(item.type);

  if (itemType === "commandExecution") {
    return asTrimmedString(item.aggregatedOutput);
  }

  if (itemType === "mcpToolCall") {
    const error = asRecord(item.error);
    const errorMessage = asTrimmedString(error?.message);
    if (errorMessage) {
      return errorMessage;
    }
    const result = asRecord(item.result);
    if (result) {
      const fromContent = extractTextFromContentArray(result.content);
      if (fromContent) {
        return fromContent;
      }
      const structured = result.structuredContent;
      if (structured && typeof structured === "object") {
        try {
          return JSON.stringify(structured, null, 2);
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  if (itemType === "dynamicToolCall") {
    return extractTextFromContentArray(item.contentItems);
  }

  if (itemType === "fileChange") {
    const changes = item.changes;
    if (Array.isArray(changes)) {
      const diffs = changes
        .map((change) => {
          if (!change || typeof change !== "object") return null;
          const record = change as Record<string, unknown>;
          return asTrimmedString(record.diff);
        })
        .filter((diff): diff is string => diff !== null);
      if (diffs.length > 0) {
        return diffs.join("\n\n");
      }
    }
    return null;
  }

  return null;
}

function extractToolFullOutput(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  if (!data) {
    return null;
  }

  const codexItem = asRecord(data.item);
  const codexOutput = extractCodexItemOutput(codexItem);
  if (codexOutput) {
    return codexOutput;
  }

  // Provider-normalized per-file changes (ACP tool calls, Codex fileChange
  // conventions): joined per-file diffs render as the item's output.
  const changeDiffs = extractDiffTextsFromChanges(data.changes);
  if (changeDiffs) {
    return changeDiffs;
  }

  const state = asRecord(data.state);
  return (
    extractToolResultText(data.rawOutput) ??
    extractToolResultText(data.output) ??
    extractToolResultText(data.result) ??
    extractToolResultText(state?.output) ??
    asTrimmedString(state?.error) ??
    asTrimmedString(asRecord(data.error)?.message) ??
    extractToolContentText(data.content) ??
    null
  );
}

function extractDiffTextsFromChanges(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const diffs: string[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const diff = asTrimmedString(record?.diff);
    if (diff) {
      diffs.push(diff);
    }
  }
  return diffs.length > 0 ? diffs.join("\n\n") : null;
}

function extractToolExitCode(payload: Record<string, unknown> | null): number | null {
  const data = asRecord(payload?.data);
  if (!data) {
    return null;
  }

  const codexItem = asRecord(data.item);
  if (codexItem) {
    const codexExit = asNumber(codexItem.exitCode);
    if (codexExit !== null && Number.isInteger(codexExit)) {
      return codexExit;
    }
  }

  const rawOutput = asRecord(data.rawOutput);
  const rawExit = asNumber(rawOutput?.exitCode);
  if (rawExit !== null && Number.isInteger(rawExit)) {
    return rawExit;
  }

  const detail = asTrimmedString(payload?.detail);
  if (!detail) {
    return null;
  }
  const stripped = stripTrailingExitCode(detail);
  return stripped.exitCode ?? null;
}

function stripTrailingExitCode(value: string): {
  output: string | null;
  exitCode?: number | undefined;
} {
  const trimmed = value.trim();
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code (?<code>\d+)>)\s*$/i.exec(
    trimmed,
  );
  if (!match?.groups) {
    return {
      output: trimmed.length > 0 ? trimmed : null,
    };
  }
  const exitCode = Number.parseInt(match.groups.code ?? "", 10);
  const normalizedOutput = match.groups.output?.trim() ?? "";
  return {
    output: normalizedOutput.length > 0 ? normalizedOutput : null,
    ...(Number.isInteger(exitCode) ? { exitCode } : {}),
  };
}

function extractWorkLogItemType(
  payload: Record<string, unknown> | null,
): WorkLogEntry["itemType"] | undefined {
  if (typeof payload?.itemType === "string" && isToolLifecycleItemType(payload.itemType)) {
    return payload.itemType;
  }
  return undefined;
}

function extractWorkLogRequestKind(
  payload: Record<string, unknown> | null,
): WorkLogEntry["requestKind"] | undefined {
  if (
    payload?.requestKind === "command" ||
    payload?.requestKind === "file-read" ||
    payload?.requestKind === "file-change"
  ) {
    return payload.requestKind;
  }
  return requestKindFromRequestType(payload?.requestType) ?? undefined;
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown) {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function readChangedFilePath(record: Record<string, unknown>): string | null {
  for (const key of ["path", "filePath", "relativePath", "filename", "newPath", "oldPath"]) {
    const normalized = asTrimmedString(record[key]);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function readChangedFileCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.trunc(value));
}

function readChangedFileStat(record: Record<string, unknown>): TurnDiffFileChange | null {
  const path = readChangedFilePath(record);
  if (!path) {
    return null;
  }

  const additions = readChangedFileCount(
    record.additions ?? record.insertions ?? record.addedLines ?? record.additionLines,
  );
  const deletions = readChangedFileCount(
    record.deletions ??
      record.deletedLines ??
      record.deletionLines ??
      record.removedLines ??
      record.removals,
  );
  if (additions === undefined && deletions === undefined) {
    return null;
  }

  return {
    path,
    ...(additions !== undefined ? { additions } : {}),
    ...(deletions !== undefined ? { deletions } : {}),
  };
}

function collectChangedFiles(value: unknown, target: string[], seen: Set<string>, depth: number) {
  if (depth > 4 || target.length >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= 12) {
      return;
    }
  }
}

function collectChangedFileStats(
  value: unknown,
  target: TurnDiffFileChange[],
  seen: Set<string>,
  depth: number,
) {
  if (depth > 4 || target.length >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFileStats(entry, target, seen, depth + 1);
      if (target.length >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  const stat = readChangedFileStat(record);
  if (stat && !seen.has(stat.path)) {
    seen.add(stat.path);
    target.push(stat);
  }

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFileStats(record[nestedKey], target, seen, depth + 1);
    if (target.length >= 12) {
      return;
    }
  }
}

function extractChangedFiles(payload: Record<string, unknown> | null): string[] {
  const changedFiles: string[] = [];
  const seen = new Set<string>();
  collectChangedFiles(asRecord(payload?.data), changedFiles, seen, 0);
  return changedFiles;
}

function extractChangedFileStats(payload: Record<string, unknown> | null): TurnDiffFileChange[] {
  const changedFileStats: TurnDiffFileChange[] = [];
  const seen = new Set<string>();
  collectChangedFileStats(asRecord(payload?.data), changedFileStats, seen, 0);
  return changedFileStats;
}

function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  const lifecycleRankComparison =
    compareActivityLifecycleRank(left.kind) - compareActivityLifecycleRank(right.kind);
  if (lifecycleRankComparison !== 0) {
    return lifecycleRankComparison;
  }

  return left.id.localeCompare(right.id);
}

function compareActivityLifecycleRank(kind: string): number {
  if (kind.endsWith(".started") || kind === "tool.started") {
    return 0;
  }
  if (kind.endsWith(".progress") || kind.endsWith(".updated")) {
    return 1;
  }
  if (kind.endsWith(".completed") || kind.endsWith(".resolved")) {
    return 2;
  }
  return 1;
}

export function hasToolActivityForTurn(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId | null | undefined,
): boolean {
  if (!turnId) return false;
  for (const activity of activities) {
    if (activity.turnId === turnId && activity.tone === "tool") {
      return true;
    }
  }
  return false;
}

export function deriveContextCompactionTimelineEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextCompactionTimelineEntry[] {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const entries: ContextCompactionTimelineEntry[] = [];
  for (const activity of ordered) {
    if (isContextCompactionActivity(activity)) {
      entries.push(toContextCompactionTimelineEntry(activity));
    }
  }
  return entries;
}

export function deriveContextHandoffTimelineEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextHandoffTimelineEntry[] {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  return ordered.flatMap((activity) => {
    const entry = toContextHandoffTimelineEntry(activity);
    return entry ? [entry] : [];
  });
}

function toContextCompactionTimelineEntry(
  activity: OrchestrationThreadActivity,
): ContextCompactionTimelineEntry {
  return {
    id: `context-compaction:${activity.id}`,
    activityId: activity.id,
    createdAt: activity.createdAt,
    label: activity.summary,
    turnId: activity.turnId,
  };
}

export function deriveThreadActivityViewModel(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | null | undefined,
): ThreadActivityViewModel {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const startedAtByToolCallId = collectToolStartTimestamps(ordered);
  const effectiveLatestTurnId = latestTurnId ?? undefined;
  const pendingApprovalState = new Map<ApprovalRequestId, PendingApproval>();
  const pendingUserInputState = new Map<ApprovalRequestId, PendingUserInput>();
  const workLogState: DerivedWorkLogEntry[] = [];
  const contextCompactionEntries: ContextCompactionTimelineEntry[] = [];
  const contextHandoffEntries: ContextHandoffTimelineEntry[] = [];
  let latestTurnHasToolActivity = false;
  let latestPlanActivity: OrchestrationThreadActivity | null = null;
  let latestPlanActivityForTurn: OrchestrationThreadActivity | null = null;

  for (const activity of ordered) {
    const payload = activityPayload(activity);

    updatePendingApprovalState(pendingApprovalState, activity, payload);
    updatePendingUserInputState(pendingUserInputState, activity, payload);

    if (activity.kind === "turn.plan.updated") {
      latestPlanActivity = activity;
      if (effectiveLatestTurnId && activity.turnId === effectiveLatestTurnId) {
        latestPlanActivityForTurn = activity;
      }
    }

    if (
      effectiveLatestTurnId &&
      !latestTurnHasToolActivity &&
      activity.turnId === effectiveLatestTurnId &&
      activity.tone === "tool"
    ) {
      latestTurnHasToolActivity = true;
    }

    if (isContextCompactionActivity(activity)) {
      contextCompactionEntries.push(toContextCompactionTimelineEntry(activity));
    }

    const contextHandoffEntry = toContextHandoffTimelineEntry(activity);
    if (contextHandoffEntry) {
      contextHandoffEntries.push(contextHandoffEntry);
    }

    if (shouldIncludeActivityInWorkLog(activity, effectiveLatestTurnId)) {
      workLogState.push(toDerivedWorkLogEntry(activity, startedAtByToolCallId));
    }
  }

  return {
    workLogEntries: toWorkLogEntries(workLogState),
    contextCompactionEntries,
    contextHandoffEntries,
    latestTurnHasToolActivity,
    pendingApprovals: pendingApprovalsFromState(pendingApprovalState),
    pendingUserInputs: pendingUserInputsFromState(pendingUserInputState),
    activePlan: toActivePlanState(latestPlanActivityForTurn ?? latestPlanActivity),
  };
}

export function deriveTimelineEntries(
  messages: ChatMessage[],
  proposedPlans: ProposedPlan[],
  workEntries: WorkLogEntry[],
  contextCompactionEntries: ContextCompactionTimelineEntry[] = [],
  contextHandoffEntries: ContextHandoffTimelineEntry[] = [],
): TimelineEntry[] {
  const messageRows: TimelineEntry[] = messages.map((message) => ({
    id: message.id,
    kind: "message",
    createdAt: message.createdAt,
    message,
  }));
  const proposedPlanRows: TimelineEntry[] = proposedPlans.map((proposedPlan) => ({
    id: proposedPlan.id,
    kind: "proposed-plan",
    createdAt: proposedPlan.createdAt,
    proposedPlan,
  }));
  const workRows: TimelineEntry[] = workEntries.map((entry) => ({
    id: entry.id,
    kind: "work",
    createdAt: entry.createdAt,
    entry,
  }));
  const contextCompactionRows: TimelineEntry[] = contextCompactionEntries.map((marker) => ({
    id: marker.id,
    kind: "context-compaction",
    createdAt: marker.createdAt,
    marker,
  }));
  const contextHandoffRows = contextHandoffEntries.map<
    Extract<TimelineEntry, { kind: "context-handoff" }>
  >((marker) => ({
    id: marker.id,
    kind: "context-handoff",
    createdAt: marker.createdAt,
    marker,
  }));

  const messageIds = new Set(messages.map((message) => message.id));
  const anchoredHandoffRows = new Map<MessageId, TimelineEntry[]>();
  const fallbackHandoffRows: TimelineEntry[] = [];
  for (const row of contextHandoffRows) {
    if (!messageIds.has(row.marker.targetMessageId)) {
      fallbackHandoffRows.push(row);
      continue;
    }
    const rowsAtAnchor = anchoredHandoffRows.get(row.marker.targetMessageId);
    if (rowsAtAnchor) {
      rowsAtAnchor.push(row);
    } else {
      anchoredHandoffRows.set(row.marker.targetMessageId, [row]);
    }
  }

  const chronologicalRows = [
    ...messageRows,
    ...proposedPlanRows,
    ...workRows,
    ...contextCompactionRows,
    ...fallbackHandoffRows,
  ].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));

  return chronologicalRows.flatMap((row) => {
    if (row.kind !== "message") {
      return [row];
    }
    const markers = anchoredHandoffRows.get(row.message.id);
    return markers ? markers.concat(row) : [row];
  });
}

export function deriveCompletionDividerBeforeEntryId(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  latestTurn: Pick<
    OrchestrationLatestTurn,
    "assistantMessageId" | "startedAt" | "completedAt"
  > | null,
): string | null {
  if (!latestTurn?.startedAt || !latestTurn.completedAt) {
    return null;
  }

  if (latestTurn.assistantMessageId) {
    const exactMatch = timelineEntries.find(
      (timelineEntry) =>
        timelineEntry.kind === "message" &&
        timelineEntry.message.role === "assistant" &&
        timelineEntry.message.id === latestTurn.assistantMessageId,
    );
    if (exactMatch) {
      return exactMatch.id;
    }
  }

  const turnStartedAt = Date.parse(latestTurn.startedAt);
  const turnCompletedAt = Date.parse(latestTurn.completedAt);
  if (Number.isNaN(turnStartedAt) || Number.isNaN(turnCompletedAt)) {
    return null;
  }

  let inRangeMatch: string | null = null;
  let fallbackMatch: string | null = null;
  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message" || timelineEntry.message.role !== "assistant") {
      continue;
    }
    const messageAt = Date.parse(timelineEntry.message.createdAt);
    if (Number.isNaN(messageAt) || messageAt < turnStartedAt) {
      continue;
    }
    fallbackMatch = timelineEntry.id;
    if (messageAt <= turnCompletedAt) {
      inRangeMatch = timelineEntry.id;
    }
  }
  return inRangeMatch ?? fallbackMatch;
}

export function inferCheckpointTurnCountByTurnId(
  summaries: TurnDiffSummary[],
): Record<TurnId, number> {
  const sorted = [...summaries].toSorted((a, b) => a.completedAt.localeCompare(b.completedAt));
  const result: Record<TurnId, number> = {};
  for (let index = 0; index < sorted.length; index += 1) {
    const summary = sorted[index];
    if (!summary) continue;
    result[summary.turnId] = index + 1;
  }
  return result;
}

export function derivePhase(session: ThreadSession | null): SessionPhase {
  if (!session || session.status === "closed") return "disconnected";
  if (session.status === "connecting") return "connecting";
  if (session.status === "running") return "running";
  return "ready";
}
