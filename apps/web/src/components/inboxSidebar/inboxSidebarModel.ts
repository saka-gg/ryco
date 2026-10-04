import { inboxModelName } from "./inboxContextHandoff";
import { getModelDisplayName } from "@ryco/shared/model";
import {
  deriveThreadActivityStatus,
  deriveUsageLimitStatus,
  type UsageLimitStatus,
} from "@ryco/client-runtime/state/threads";
import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { WsConnectionUiState } from "@ryco/client-runtime/rpc";
import { PROVIDER_OPTIONS } from "@ryco/client-runtime/state/session";
import type {
  Project,
  SidebarThreadSummary,
  SidebarWorktreeSummary,
} from "@ryco/client-runtime/state/threads";
import { buildThreadInbox, type ThreadInboxEntry } from "@ryco/client-runtime/state/threads";
import {
  describeThreadPriorityFocus,
  type ThreadPriorityFocusMetadata,
} from "@ryco/shared/threadPriority";
import {
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type ModelSelection,
  type ServerProvider,
  type ServerConfig,
  type ProviderDriverKind,
  type SidebarAutoSettleAfterDays,
  type ThreadId,
} from "@ryco/contracts";

export type InboxSidebarThreadState =
  | "needs-input"
  | "delivery-unknown"
  | "working"
  | "connecting"
  | "limited"
  | "error"
  | "reconnecting"
  | "offline"
  | "idle";

/** What a needs-input thread is waiting on. */
export type InboxSidebarAttention = "approval" | "input" | "plan";

export type InboxSidebarSectionKey =
  | "pinned"
  | "focus"
  | "active"
  | "needs-input"
  | "recent"
  | "settled"
  | "snoozed";
export type InboxSidebarStatusFilter = "all" | InboxSidebarSectionKey;

export interface InboxSidebarEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly connectionState: "connected" | "connecting" | "reconnecting" | "offline" | "idle";
  readonly stale: boolean;
  readonly staleDetail?: string;
  readonly role: "viewer" | "operator" | "owner" | "client" | null;
  readonly trust:
    | "not-required"
    | "unknown"
    | "unverified"
    | "account-trusted"
    | "verified"
    | "identity-conflict";
  readonly deliveryUnknown: boolean;
  readonly threadSettlementSupported: boolean;
  readonly threadSnoozeSupported?: boolean | undefined;
  readonly mutationReady: boolean;
  readonly shellCurrent: boolean;
}

export interface InboxSidebarRow {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly pinned: boolean;
  readonly gitCwd: string | null;
  readonly sourceControlEnabled: boolean;
  readonly mutationEnabled: boolean;
  readonly pullRequest: {
    readonly number: number;
    readonly state: "open" | "closed" | "merged" | null;
    readonly isDraft: boolean;
  } | null;
  readonly machineLabel: string;
  readonly projectLabel: string;
  readonly project: Project | null;
  readonly isWorktree: boolean;
  readonly rankingModelLabel: string | null;
  readonly workspaceLabel: string;
  readonly contextLabel: string;
  readonly state: InboxSidebarThreadState;
  readonly statusLabel: string;
  /** Set only while `state` is "needs-input". */
  readonly attention: InboxSidebarAttention | null;
  /** Provider error text, set only while `state` is "error". */
  readonly errorDetail: string | null;
  /** The usage limit's phase and reset, set only while `state` is "limited". */
  readonly usageLimit?: Pick<UsageLimitStatus, "phase" | "resetAt"> | null;
  /** Start of the running turn, set only while `state` is "working". */
  readonly runningSince: string | null;
  /** Completion of the latest turn; compared against the last visit for unseen work. */
  readonly latestTurnCompletedAt: string | null;
  /** The machine is implicit when every thread lives on the primary environment. */
  readonly showMachine: boolean;
  /** Project icons fall back to a folder, so the name is shown once projects differ. */
  readonly showProject: boolean;
  readonly updatedAt: string;
  readonly providerDriver: ProviderDriverKind | null;
  readonly providerLabel: string | null;
  readonly modelLabel: string | null;
  readonly modelSelection: ModelSelection | null;
  readonly branchLabel: string | null;
  readonly changeRequestLabel: string | null;
  readonly changeRequestStateLabel: string | null;
  readonly trustLabel: "Not verified" | "Encrypted · Account trusted" | "Identity conflict" | null;
  readonly roleLabel: "Viewer" | null;
  readonly settled: boolean;
  readonly snoozedUntil: string | null;
  readonly canSnooze: boolean;
  readonly canUnsnooze: boolean;
  readonly settlementActionEnabled: boolean;
  readonly settlementDisabledReason: string | null;
  readonly effectiveSettlementTimestamp: string | null;
  readonly focus: ThreadPriorityFocusMetadata | null;
}

export interface InboxSidebarSection {
  readonly key: InboxSidebarSectionKey;
  readonly title:
    | "Pinned"
    | "Focus"
    | "Active now"
    | "Needs input"
    | "Recent"
    | "Settled"
    | "Snoozed";
  readonly rows: ReadonlyArray<InboxSidebarRow>;
}

export interface InboxSidebarFilters {
  readonly query: string;
  readonly environmentId: EnvironmentId | null;
  readonly status: InboxSidebarStatusFilter;
}

export interface BuildInboxSidebarInput {
  readonly projects: ReadonlyArray<Project>;
  readonly worktrees: ReadonlyArray<SidebarWorktreeSummary>;
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
  readonly environments: ReadonlyArray<InboxSidebarEnvironment>;
  readonly filters: InboxSidebarFilters;
  readonly deliveryUnknownThreadKeys?: ReadonlySet<string>;
  readonly localQueuedThreadKeys?: ReadonlySet<string>;
  readonly activeThreadKey?: string | null;
  readonly aiFocusEnabled?: boolean;
  readonly autoSettleAfterDays?: SidebarAutoSettleAfterDays;
  readonly pinnedThreadKeys?: ReadonlySet<string>;
  /** The environment rows are implicitly about; other machines are labelled. */
  readonly primaryEnvironmentId?: EnvironmentId | null;
  readonly nowMs?: number;
}

export interface InboxSidebarModel {
  readonly sections: ReadonlyArray<InboxSidebarSection>;
  readonly nextSettlementEvaluationAtMs: number | null;
}

export interface InboxFocusExplanation {
  readonly title: string;
  readonly detail: string;
  readonly aiGenerated: boolean;
}

export function describeInboxFocus(focus: ThreadPriorityFocusMetadata): InboxFocusExplanation {
  return describeThreadPriorityFocus(focus);
}

export function buildPrimaryInboxSidebarEnvironment(input: {
  readonly label: string;
  readonly environmentId: EnvironmentId;
  readonly connectionState: WsConnectionUiState;
  readonly hydratedFromCache: boolean;
  readonly threadSettlementSupported: boolean;
  readonly threadSnoozeSupported?: boolean | undefined;
}): InboxSidebarEnvironment {
  const connectionState =
    input.connectionState === "error" ? "reconnecting" : input.connectionState;
  const stale = input.hydratedFromCache || connectionState === "offline";
  return {
    environmentId: input.environmentId,
    label: input.label,
    connectionState,
    stale,
    ...(stale ? { staleDetail: "Offline · last known" } : {}),
    role: "owner",
    trust: "not-required",
    deliveryUnknown: false,
    threadSettlementSupported: input.threadSettlementSupported,
    threadSnoozeSupported: input.threadSnoozeSupported,
    mutationReady: connectionState === "connected" && !stale,
    shellCurrent: !stale,
  };
}

const ACTIVE_PRIORITY: Readonly<
  Record<Exclude<InboxSidebarThreadState, "idle" | "offline" | "needs-input">, number>
> = {
  "delivery-unknown": 0,
  error: 1,
  limited: 1,
  working: 2,
  connecting: 3,
  reconnecting: 4,
};

function resolveProviderDriver(thread: SidebarThreadSummary): ProviderDriverKind | null {
  const direct = thread.session?.provider ?? thread.providerDriver ?? null;
  if (direct) return direct;
  const instanceId = thread.modelSelection?.instanceId;
  if (!instanceId) return null;
  return (
    PROVIDER_OPTIONS.find((option) => defaultInstanceIdForDriver(option.value) === instanceId)
      ?.value ?? null
  );
}

function resolveThreadState(
  thread: SidebarThreadSummary,
  environment: InboxSidebarEnvironment | undefined,
  deliveryUnknownThreadKeys: ReadonlySet<string>,
  nowMs: number,
): InboxSidebarThreadState {
  if (environment?.stale || environment?.connectionState === "offline") return "offline";
  const activity = deriveThreadActivityStatus(thread);
  if (activity === "approval" || activity === "input" || activity === "plan-ready")
    return "needs-input";
  if (
    environment?.deliveryUnknown ||
    deliveryUnknownThreadKeys.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)))
  ) {
    return "delivery-unknown";
  }
  if (activity === "working") {
    return "working";
  }
  if (activity === "connecting" || environment?.connectionState === "connecting") {
    return "connecting";
  }
  // A running resumed turn wins above; a usage limit outranks the error it ended in.
  if (deriveUsageLimitStatus(thread, nowMs) !== null) return "limited";
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") return "error";
  if (environment?.connectionState === "reconnecting") return "reconnecting";
  return "idle";
}

function resolveAttention(thread: SidebarThreadSummary): InboxSidebarAttention {
  const activity = deriveThreadActivityStatus(thread);
  if (activity === "approval") return "approval";
  if (activity === "plan-ready") return "plan";
  return "input";
}

function resolveRunningSince(thread: SidebarThreadSummary): string | null {
  const turn = thread.latestTurn;
  // Background liveness has no turn clock; the row falls back to recency.
  return turn?.state === "running" ? (turn.startedAt ?? turn.requestedAt) : null;
}

function statusLabel(
  state: InboxSidebarThreadState,
  environment: InboxSidebarEnvironment | undefined,
  usageLimit: UsageLimitStatus | null,
): string {
  switch (state) {
    case "limited":
      return usageLimit?.label ?? "Limited";
    case "needs-input":
      return "Needs input";
    case "delivery-unknown":
      return "Check delivery";
    case "working":
      return "Working";
    case "connecting":
      return "Connecting";
    case "error":
      return "Error";
    case "reconnecting":
      return "Reconnecting";
    case "offline":
      return environment?.staleDetail ?? "Offline";
    case "idle":
      return "Idle";
  }
}

/**
 * The status half of an inbox row for one thread, without its environment.
 * Split-pane titles use it so a pane shows the same glyph as the inbox row.
 */
export function resolveInboxThreadStatus(
  thread: SidebarThreadSummary,
): Pick<InboxSidebarRow, "state" | "statusLabel" | "attention"> {
  const nowMs = Date.now();
  const state = resolveThreadState(thread, undefined, new Set(), nowMs);
  return {
    state,
    statusLabel: statusLabel(
      state,
      undefined,
      state === "limited" ? deriveUsageLimitStatus(thread, nowMs) : null,
    ),
    attention: state === "needs-input" ? resolveAttention(thread) : null,
  };
}

function sectionKey(state: InboxSidebarThreadState): InboxSidebarSectionKey {
  if (state === "needs-input") return "needs-input";
  if (state === "idle" || state === "offline") return "recent";
  return "active";
}

function timestamp(thread: SidebarThreadSummary): string {
  if (thread.latestCompletedTurnAt !== undefined) {
    return thread.latestCompletedTurnAt ?? thread.createdAt;
  }
  // Older servers only expose the latest turn. Never use general update times:
  // they advance for streamed text, tools, user prompts, and metadata changes.
  const turn = thread.latestTurn;
  const running =
    thread.session?.activeTurnId === turn?.turnId ||
    thread.session?.orchestrationStatus === "running" ||
    thread.session?.orchestrationStatus === "starting";
  return turn?.state === "completed" && !running
    ? (turn.completedAt ?? thread.createdAt)
    : thread.createdAt;
}

function compareRecent(left: InboxSidebarRow, right: InboxSidebarRow): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  const delta = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  if (Number.isFinite(delta) && delta !== 0) return delta;
  return left.key.localeCompare(right.key);
}

function compareActive(left: InboxSidebarRow, right: InboxSidebarRow): number {
  if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
  const leftPriority = ACTIVE_PRIORITY[left.state as keyof typeof ACTIVE_PRIORITY] ?? 0;
  const rightPriority = ACTIVE_PRIORITY[right.state as keyof typeof ACTIVE_PRIORITY] ?? 0;
  return leftPriority - rightPriority || compareRecent(left, right);
}

function settlementDisabledReason(entry: ThreadInboxEntry): string | null {
  switch (entry.mutationBlocker) {
    case "client-draft":
      return "Drafts cannot be settled yet.";
    case "unsupported":
      return "Update this machine to use Settle.";
    case "disconnected":
      return "Reconnect this machine to change settlement.";
    case "read-only":
      return "Your role cannot change this thread.";
    case "shell-stale":
      return "Wait for current thread data before changing settlement.";
    case null:
      break;
  }

  switch (entry.lifecycle.settlementBlocker) {
    case "pending-approval":
      return "Resolve the pending approval first.";
    case "pending-user-input":
      return "Answer the pending request first.";
    case "session-starting":
    case "session-running":
      return "Wait for the running work to finish.";
    case "queued-turn":
    case "local-queue":
      return "Wait for queued work to be delivered.";
    case "delivery-unknown":
      return "Confirm message delivery before settling.";
    case "thread-archived":
    case "thread-deleted":
    case "worktree-archived":
      return "Archived work cannot be settled.";
    case "unsupported":
      return "Update this machine to use Settle.";
    case null:
      return null;
  }

  return null;
}

function modelDisplayName(
  selection: ModelSelection | null | undefined,
  environment: InboxSidebarEnvironment | undefined,
): string | null {
  if (!selection) return null;
  const provider = environment?.providers?.find(
    (provider) => provider.instanceId === selection.instanceId,
  );
  const model = provider?.models.find(
    (model) => model.slug === selection.model || model.aliases?.includes(selection.model),
  );
  return model ? inboxModelName(getModelDisplayName(model), provider!.driver) : null;
}

export function buildInboxSidebarModel(input: BuildInboxSidebarInput): InboxSidebarModel {
  const nowMs = input.nowMs ?? Date.now();
  const environmentById = new Map(
    input.environments.map((environment) => [environment.environmentId, environment] as const),
  );
  const deliveryUnknownThreadKeys = input.deliveryUnknownThreadKeys ?? new Set<string>();
  const inbox = buildThreadInbox({
    projects: input.projects,
    worktrees: input.worktrees,
    threads: input.threads,
    environments: input.environments.map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
      threadSettlementSupported: environment.threadSettlementSupported,
      threadSnoozeSupported: environment.threadSnoozeSupported,
      connected: environment.connectionState === "connected",
      mutationReady: environment.mutationReady,
      shellCurrent: environment.shellCurrent,
    })),
    localQueuedThreadKeys: input.localQueuedThreadKeys,
    deliveryUnknownThreadKeys,
    pinnedThreadKeys: input.pinnedThreadKeys,
    filters: {
      ...(input.filters.environmentId ? { environmentIds: [input.filters.environmentId] } : {}),
      text: input.filters.query,
    },
    currentThreadKey: input.activeThreadKey,
    aiFocusEnabled: input.aiFocusEnabled,
    autoSettleAfterDays: input.autoSettleAfterDays,
    nowMs,
  });

  const threadEnvironmentIds = new Set(input.threads.map((thread) => thread.environmentId));
  const singleEnvironment = threadEnvironmentIds.size <= 1;
  const projectNameByKey = new Map(
    input.projects.map((project) => [`${project.environmentId}:${project.id}`, project.name]),
  );
  const threadProjectNames = new Set(
    input.threads.map(
      (thread) => projectNameByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null,
    ),
  );
  const singleProject = threadProjectNames.size <= 1;
  const rows: InboxSidebarRow[] = [];
  for (const entry of [...inbox.focus, ...inbox.active, ...inbox.settled, ...inbox.snoozed]) {
    const thread = entry.thread;
    if (!thread) continue;
    const environment = environmentById.get(thread.environmentId);
    const project = entry.project;
    const worktree = entry.worktree;
    const machineLabel = environment?.label ?? "Unknown machine";
    const projectLabel = project?.name ?? "Unknown project";
    const workspaceLabel =
      worktree?.title ?? worktree?.branch ?? thread.branch ?? "Local workspace";
    const contextLabel = `${machineLabel} · ${projectLabel} · ${workspaceLabel}`;
    const state = resolveThreadState(thread, environment, deliveryUnknownThreadKeys, nowMs);
    const usageLimit = state === "limited" ? deriveUsageLimitStatus(thread, nowMs) : null;
    const settled = entry.lifecycle.classification === "settled";
    const snoozed = entry.lifecycle.classification === "snoozed";
    const rowSection = entry.pinned
      ? "pinned"
      : snoozed
        ? "snoozed"
        : settled
          ? "settled"
          : entry.focus
            ? "focus"
            : sectionKey(state);
    if (input.filters.status !== "all" && input.filters.status !== rowSection) continue;
    const providerDriver = resolveProviderDriver(thread);
    rows.push({
      key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      environmentId: thread.environmentId,
      threadId: thread.id,
      title: thread.title || "Untitled task",
      pinned: entry.pinned,
      gitCwd: thread.worktreePath ?? worktree?.worktreePath ?? project?.cwd ?? null,
      sourceControlEnabled: Boolean(
        environment?.connectionState === "connected" &&
        environment.shellCurrent &&
        !environment.stale,
      ),
      mutationEnabled: Boolean(
        environment?.mutationReady &&
        environment.shellCurrent &&
        environment.connectionState === "connected",
      ),
      pullRequest:
        worktree?.prNumber != null
          ? {
              number: worktree.prNumber,
              state: worktree.prState,
              isDraft: worktree.prIsDraft === true,
            }
          : null,
      machineLabel,
      projectLabel,
      project: project ?? null,
      isWorktree: Boolean(worktree?.worktreePath ?? thread.worktreePath),
      rankingModelLabel: modelDisplayName(entry.focus?.ranking?.modelSelection, environment),
      workspaceLabel,
      contextLabel,
      state,
      statusLabel: statusLabel(state, environment, usageLimit),
      attention: state === "needs-input" ? resolveAttention(thread) : null,
      errorDetail: state === "error" ? thread.session?.lastError?.trim() || null : null,
      usageLimit: usageLimit ? { phase: usageLimit.phase, resetAt: usageLimit.resetAt } : null,
      runningSince: state === "working" ? resolveRunningSince(thread) : null,
      latestTurnCompletedAt: thread.latestTurn?.completedAt ?? null,
      showProject: !singleProject,
      showMachine:
        !singleEnvironment &&
        (input.primaryEnvironmentId == null || thread.environmentId !== input.primaryEnvironmentId),
      updatedAt: timestamp(thread),
      providerDriver,
      providerLabel:
        PROVIDER_OPTIONS.find((option) => option.value === providerDriver)?.label ??
        providerDriver ??
        null,
      modelLabel: modelDisplayName(thread.modelSelection, environment),
      modelSelection: thread.modelSelection ?? null,
      branchLabel: thread.branch ?? worktree?.branch ?? null,
      changeRequestLabel:
        worktree?.prNumber != null
          ? `#${worktree.prNumber}`
          : worktree?.issueNumber != null
            ? `#${worktree.issueNumber}`
            : (worktree?.workItemKey ?? null),
      changeRequestStateLabel:
        worktree?.prState ??
        worktree?.issueState ??
        worktree?.workItemStateName ??
        worktree?.workItemState ??
        null,
      trustLabel:
        environment?.trust === "unverified"
          ? "Not verified"
          : environment?.trust === "account-trusted"
            ? "Encrypted · Account trusted"
            : environment?.trust === "identity-conflict"
              ? "Identity conflict"
              : null,
      roleLabel: environment?.role === "viewer" ? "Viewer" : null,
      settled,
      snoozedUntil: snoozed ? (thread.snoozedUntil ?? null) : null,
      canSnooze: entry.canSnooze,
      canUnsnooze:
        environment?.threadSnoozeSupported === true &&
        environment.mutationReady &&
        environment.shellCurrent &&
        environment.connectionState === "connected",
      settlementActionEnabled:
        entry.mutationEnabled && (settled || entry.lifecycle.eligibility.canSettle),
      settlementDisabledReason: settlementDisabledReason(entry),
      effectiveSettlementTimestamp: entry.lifecycle.effectiveSettlementTimestamp,
      focus: entry.focus,
    });
  }

  const pinned = rows.filter((row) => row.pinned).toSorted(compareRecent);
  const unpinnedRows = rows.filter((row) => !row.pinned);
  const unsettledRows = unpinnedRows.filter((row) => !row.settled && !row.snoozedUntil);
  const focus = unsettledRows.filter((row) => row.focus !== null);
  const active = unsettledRows
    .filter((row) => row.focus === null && sectionKey(row.state) === "active")
    .toSorted(compareActive);
  const needsInput = unsettledRows
    .filter((row) => row.focus === null && !row.settled && sectionKey(row.state) === "needs-input")
    .toSorted(compareRecent);
  const recent = unsettledRows
    .filter((row) => row.focus === null && sectionKey(row.state) === "recent")
    .toSorted(compareRecent);
  const settled = unpinnedRows
    .filter((row) => row.settled)
    .toSorted((left, right) =>
      (right.effectiveSettlementTimestamp ?? right.updatedAt).localeCompare(
        left.effectiveSettlementTimestamp ?? left.updatedAt,
      ),
    );

  return {
    sections: [
      ...(pinned.length > 0 ? [{ key: "pinned", title: "Pinned", rows: pinned } as const] : []),
      ...(focus.length > 0 ? [{ key: "focus", title: "Focus", rows: focus } as const] : []),
      ...(active.length > 0 ? [{ key: "active", title: "Active now", rows: active } as const] : []),
      ...(needsInput.length > 0
        ? [{ key: "needs-input", title: "Needs input", rows: needsInput } as const]
        : []),
      ...(recent.length > 0 ? [{ key: "recent", title: "Recent", rows: recent } as const] : []),
      ...(unpinnedRows.some((row) => row.snoozedUntil)
        ? [
            {
              key: "snoozed",
              title: "Snoozed",
              rows: unpinnedRows.filter((row) => row.snoozedUntil),
            } as const,
          ]
        : []),
      ...(settled.length > 0 ? [{ key: "settled", title: "Settled", rows: settled } as const] : []),
    ],
    nextSettlementEvaluationAtMs: inbox.nextSettlementEvaluationAtMs,
  };
}

export function buildInboxSidebarSections(
  input: BuildInboxSidebarInput,
): ReadonlyArray<InboxSidebarSection> {
  return buildInboxSidebarModel(input).sections;
}

/** Live config is node-owned; hosted directory descriptors intentionally start without capabilities. */
export function applyInboxServerConfig(
  environment: InboxSidebarEnvironment,
  config: Pick<ServerConfig, "environment" | "providers"> | null | undefined,
): InboxSidebarEnvironment {
  if (!config) return environment;
  return {
    ...environment,
    threadSnoozeSupported: config.environment.capabilities.threadSnooze ?? false,
    threadSettlementSupported: config.environment.capabilities.threadSettlement,
    providers: config.providers,
  };
}
