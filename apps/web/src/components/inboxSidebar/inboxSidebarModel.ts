import { inboxModelName } from "./inboxContextHandoff";
import { getModelDisplayName } from "@ryco/shared/model";
import {
  deriveThreadActivityStatus,
  deriveUsageLimitStatus,
  type UsageLimitStatus,
} from "@ryco/client-runtime/state/threads";
import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { CHAT_WORKSPACE_LABEL, projectDisplayLabel } from "@ryco/client-runtime/state/composer";
import { isChatProject } from "@ryco/shared/projectKind";
import type { SavedEnvironmentRuntimeState } from "@ryco/client-runtime/connection";
import type { WsConnectionUiState } from "@ryco/client-runtime/rpc";
import { PROVIDER_OPTIONS } from "@ryco/client-runtime/state/session";
import type {
  Project,
  SidebarThreadOrStub,
  SidebarThreadSummary,
  SidebarWorktreeSummary,
} from "@ryco/client-runtime/state/threads";
import {
  buildThreadInbox,
  planDelegatedNesting,
  resolveThreadWorkspacePullRequestLink,
  type DelegatedNestingItem,
  type ThreadInboxEntry,
} from "@ryco/client-runtime/state/threads";
import {
  visiblePullRequestLinks,
  workspaceDiscoversPullRequests,
  type WorktreePullRequestLink,
} from "@ryco/shared/worktreePullRequests";
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
  type ThreadLineage,
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
  /** Waiting for a free connection slot: shown as "Waiting", not as a reconnect. */
  readonly queued?: boolean | undefined;
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

export interface InboxSidebarPullRequest {
  readonly number: number;
  readonly state: "open" | "closed" | "merged" | null;
  readonly isDraft: boolean;
  readonly title?: string | undefined;
  readonly url?: string | undefined;
}

function inboxPullRequestFromLink(link: WorktreePullRequestLink): InboxSidebarPullRequest {
  return {
    number: link.number,
    state: link.state,
    isDraft: link.isDraft === true,
    ...(link.title ? { title: link.title } : {}),
    ...(link.url ? { url: link.url } : {}),
  };
}

/** A row's pull requests: the thread's own, and the rest of its workspace's. */
function resolveRowPullRequests(
  thread: SidebarThreadSummary,
  worktree: SidebarWorktreeSummary | null | undefined,
): Pick<
  InboxSidebarRow,
  | "pullRequest"
  | "pullRequestLinked"
  | "otherPullRequests"
  | "dismissedPullRequestNumbers"
  | "pullRequestsDiscovered"
> {
  const link = resolveThreadWorkspacePullRequestLink(thread, worktree ?? null);
  if (link === undefined) {
    // A server that predates links: the workspace's one pull request.
    return {
      pullRequest:
        worktree?.prNumber != null
          ? {
              number: worktree.prNumber,
              state: worktree.prState,
              isDraft: worktree.prIsDraft === true,
            }
          : null,
      pullRequestLinked: false,
      otherPullRequests: [],
      dismissedPullRequestNumbers: [],
      pullRequestsDiscovered: false,
    };
  }
  return {
    pullRequest: link ? inboxPullRequestFromLink(link) : null,
    pullRequestLinked: link !== null,
    otherPullRequests: visiblePullRequestLinks(worktree?.pullRequests ?? [])
      .filter((other) => other.number !== link?.number)
      .map(inboxPullRequestFromLink),
    dismissedPullRequestNumbers: (worktree?.pullRequests ?? [])
      .filter((other) => other.dismissedAt)
      .map((other) => other.number),
    pullRequestsDiscovered: workspaceDiscoversPullRequests(worktree),
  };
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
  /** The pull request the thread answers to (the one that settles it). */
  readonly pullRequest: InboxSidebarPullRequest | null;
  /**
   * `pullRequest` is one of the workspace's stored links, so live git status
   * may only enrich it; otherwise (older servers) the branch's live one wins.
   */
  readonly pullRequestLinked: boolean;
  /** The workspace's other visible pull requests, for the hover card. */
  readonly otherPullRequests: ReadonlyArray<InboxSidebarPullRequest>;
  /** Pull requests the user unlinked: live git status must not bring them back. */
  readonly dismissedPullRequestNumbers: ReadonlyArray<number>;
  /**
   * The server discovers the workspace's pull requests, so a finished one git
   * status reports but the workspace does not carry is stale.
   */
  readonly pullRequestsDiscovered: boolean;
  readonly machineLabel: string;
  readonly projectLabel: string;
  readonly project: Project | null;
  /** The thread is a "No project" chat (its project is a chat folder). */
  readonly isChat: boolean;
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
  /** Server-owned provenance; null on root threads. */
  readonly lineage: ThreadLineage | null;
  /** Delegated descendants folded under this host row; empty unless it is a host. */
  readonly delegatedChildren: ReadonlyArray<InboxSidebarRow>;
  /** `state` is a folded delegated child's (working or needs input), not this thread's own. */
  readonly delegatedState: boolean;
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
  /** Archived threads may be stubs: they only feed lineage walks and counts. */
  readonly threads: ReadonlyArray<SidebarThreadOrStub>;
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
  /** Fold delegated children under their host (default true; off on the phone tier). */
  readonly nestDelegated?: boolean;
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

/** The inbox's view of a directly paired environment the app saved. */
export function buildSavedInboxSidebarEnvironment(input: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly runtime: SavedEnvironmentRuntimeState | null | undefined;
  readonly hydratedFromCache: boolean;
}): InboxSidebarEnvironment {
  const runtime = input.runtime;
  // A rejected pairing is not an outage: no reconnect will fix it, so the row
  // says what will, instead of "reconnecting" forever.
  const requiresAuth = runtime?.authState === "requires-auth";
  const connectionState = requiresAuth
    ? "disconnected"
    : (runtime?.connectionState ?? "disconnected");
  const stale = input.hydratedFromCache || connectionState !== "connected";
  return {
    environmentId: input.environmentId,
    label: input.label,
    connectionState:
      connectionState === "connected"
        ? "connected"
        : connectionState === "connecting"
          ? "connecting"
          : connectionState === "error"
            ? "reconnecting"
            : "offline",
    stale,
    ...(requiresAuth
      ? { staleDetail: "Needs re-pair" }
      : stale
        ? { staleDetail: "Offline · last known" }
        : {}),
    role: runtime?.role ?? null,
    trust: "unknown",
    deliveryUnknown: false,
    threadSnoozeSupported: runtime?.descriptor?.capabilities.threadSnooze ?? false,
    threadSettlementSupported: runtime?.descriptor?.capabilities.threadSettlement ?? false,
    mutationReady:
      connectionState === "connected" &&
      (runtime?.role === "owner" || runtime?.role === "client") &&
      !stale,
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

/** Start of the running turn; background work has no turn clock. */
export function resolveRunningSince(
  thread: Pick<SidebarThreadSummary, "latestTurn">,
): string | null {
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
      return environment?.queued ? "Waiting" : "Reconnecting";
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

/** `resolveThreadState`'s order: a host takes a child's state only over a weaker own state. */
const STATE_PRECEDENCE: Readonly<Record<InboxSidebarThreadState, number>> = {
  offline: 0,
  "needs-input": 1,
  "delivery-unknown": 2,
  working: 3,
  connecting: 4,
  limited: 5,
  error: 6,
  reconnecting: 7,
  idle: 8,
};

/**
 * State-derived section. It also ranks delegated nesting: a child more urgent
 * than a snoozed or settled host stays top-level instead of folding out of sight.
 */
function sectionKey(
  state: InboxSidebarThreadState,
): Extract<InboxSidebarSectionKey, "needs-input" | "active" | "recent"> {
  if (state === "needs-input") return "needs-input";
  if (state === "idle" || state === "offline") return "recent";
  return "active";
}

const NO_DELEGATED_CHILDREN: ReadonlyArray<InboxSidebarRow> = [];
const UNKNOWN_PROJECT_LABEL = "Unknown project";

/**
 * A host carries what its folded children are doing: it is working while one of
 * them works and needs input while one of them does, unless its own state is
 * stronger. The host then sorts into that section, so folding never hides live
 * work. A child's error stays on the child row, under its own glyph.
 */
function withDelegatedState(host: InboxSidebarRow): InboxSidebarRow {
  const asking = host.delegatedChildren.find((child) => child.state === "needs-input");
  const working = host.delegatedChildren.filter((child) => child.state === "working");
  const inherited = asking ? "needs-input" : working.length > 0 ? "working" : null;
  if (inherited === null || STATE_PRECEDENCE[host.state] <= STATE_PRECEDENCE[inherited]) {
    return host;
  }
  // The earliest running child's clock; background work without one falls back to recency.
  const runningSince =
    working
      .flatMap((child) => (child.runningSince ? [child.runningSince] : []))
      .toSorted((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;
  return {
    ...host,
    state: inherited,
    statusLabel: statusLabel(inherited, undefined, null),
    attention: asking?.attention ?? null,
    errorDetail: null,
    usageLimit: null,
    runningSince: inherited === "working" ? runningSince : null,
    delegatedState: true,
  };
}

/**
 * Folds delegated children under their topmost visible host (spec D7/D8),
 * whatever their state; the host takes on their working or needs-input state.
 */
function nestDelegatedRows(
  rows: ReadonlyArray<InboxSidebarRow>,
  threads: ReadonlyArray<SidebarThreadOrStub>,
): InboxSidebarRow[] {
  // All threads, so filtered-out or archived intermediates can still be walked.
  const lineageByKey = new Map(
    threads.map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      thread.lineage,
    ]),
  );
  const items = rows.map((row): DelegatedNestingItem => ({
    key: row.key,
    environmentId: row.environmentId,
    threadId: row.threadId,
    lineage: row.lineage,
    pinned: row.pinned,
    focused: row.focus !== null,
    urgency: row.snoozedUntil ? "snoozed" : row.settled ? "settled" : sectionKey(row.state),
  }));
  const plan = planDelegatedNesting(items, { lineageByKey });
  if (plan.hostByChildKey.size === 0) return [...rows];
  const rowByKey = new Map(rows.map((row) => [row.key, row]));
  return rows.flatMap((row) => {
    if (plan.hostByChildKey.has(row.key)) return [];
    const childKeys = plan.childKeysByHostKey.get(row.key);
    if (childKeys === undefined) return [row];
    const delegatedChildren = childKeys
      .flatMap((key) => {
        const child = rowByKey.get(key);
        return child ? [child] : [];
      })
      .toSorted(compareRecent);
    return [withDelegatedState({ ...row, delegatedChildren })];
  });
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

/** A model's short display name from its provider's catalog; null when the catalog lacks it. */
export function modelDisplayName(
  selection: ModelSelection | null | undefined,
  providers: ReadonlyArray<ServerProvider> | null | undefined,
): string | null {
  if (!selection) return null;
  const provider = providers?.find((provider) => provider.instanceId === selection.instanceId);
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
    input.projects.map((project) => [
      `${project.environmentId}:${project.id}`,
      projectDisplayLabel(project, UNKNOWN_PROJECT_LABEL),
    ]),
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
    const isChat = isChatProject(project);
    // A chat's project is its folder, not something to name: chats read "No project".
    const projectLabel = projectDisplayLabel(project, UNKNOWN_PROJECT_LABEL);
    const workspaceLabel = isChat
      ? CHAT_WORKSPACE_LABEL
      : (worktree?.title ?? worktree?.branch ?? thread.branch ?? "Local workspace");
    const contextLabel = `${machineLabel} · ${projectLabel} · ${workspaceLabel}`;
    const state = resolveThreadState(thread, environment, deliveryUnknownThreadKeys, nowMs);
    const usageLimit = state === "limited" ? deriveUsageLimitStatus(thread, nowMs) : null;
    const settled = entry.lifecycle.classification === "settled";
    const snoozed = entry.lifecycle.classification === "snoozed";
    const providerDriver = resolveProviderDriver(thread);
    const rowPullRequests = resolveRowPullRequests(thread, worktree);
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
      ...rowPullRequests,
      machineLabel,
      projectLabel,
      project: project ?? null,
      isChat,
      isWorktree: Boolean(worktree?.worktreePath ?? thread.worktreePath),
      rankingModelLabel: modelDisplayName(
        entry.focus?.ranking?.modelSelection,
        environment?.providers,
      ),
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
      modelLabel: modelDisplayName(thread.modelSelection, environment?.providers),
      modelSelection: thread.modelSelection ?? null,
      branchLabel: thread.branch ?? worktree?.branch ?? null,
      changeRequestLabel:
        rowPullRequests.pullRequest !== null
          ? `#${rowPullRequests.pullRequest.number}`
          : worktree?.issueNumber != null
            ? `#${worktree.issueNumber}`
            : (worktree?.workItemKey ?? null),
      changeRequestStateLabel:
        (rowPullRequests.pullRequest !== null ? rowPullRequests.pullRequest.state : null) ??
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
      lineage: thread.lineage ?? null,
      delegatedChildren: NO_DELEGATED_CHILDREN,
      delegatedState: false,
    });
  }

  // Text search shows every match as its own row. A status filter keeps folding:
  // it shows its section as the unfiltered inbox does, with each host's children.
  const topLevelRows =
    input.nestDelegated !== false && input.filters.query.trim() === ""
      ? nestDelegatedRows(rows, input.threads)
      : rows;
  const pinned = topLevelRows.filter((row) => row.pinned).toSorted(compareRecent);
  const unpinnedRows = topLevelRows.filter((row) => !row.pinned);
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

  const sections: InboxSidebarSection[] = [
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
  ];

  const status = input.filters.status;
  return {
    sections: status === "all" ? sections : sections.filter((section) => section.key === status),
    nextSettlementEvaluationAtMs: inbox.nextSettlementEvaluationAtMs,
  };
}

export function buildInboxSidebarSections(
  input: BuildInboxSidebarInput,
): ReadonlyArray<InboxSidebarSection> {
  return buildInboxSidebarModel(input).sections;
}

/** Row data is shallow JSON; anything nested deeper than this is treated as changed. */
const MAX_SHARED_VALUE_DEPTH = 6;

function isPlainRecord(value: object): value is Readonly<Record<string, unknown>> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Equal data, whatever the identity: fresh copies of unchanged pull requests match. */
function sameInboxValue(left: unknown, right: unknown, depth = 0): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (depth >= MAX_SHARED_VALUE_DEPTH) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameInboxValue(item, right[index], depth + 1))
    );
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.hasOwn(right, key) && sameInboxValue(left[key], right[key], depth + 1),
    )
  );
}

function sameElements<T>(left: ReadonlyArray<T>, right: ReadonlyArray<T>): boolean {
  return (
    left === right || (left.length === right.length && left.every((item, i) => item === right[i]))
  );
}

/** Folded children are compared by identity: they are shared before their host. */
function sameInboxRow(previous: InboxSidebarRow, next: InboxSidebarRow): boolean {
  const keys = Object.keys(next) as Array<keyof InboxSidebarRow>;
  return (
    keys.length === Object.keys(previous).length &&
    keys.every((key) =>
      key === "delegatedChildren"
        ? sameElements(previous.delegatedChildren, next.delegatedChildren)
        : Object.hasOwn(previous, key) && sameInboxValue(previous[key], next[key]),
    )
  );
}

export interface InboxSidebarModelSharing {
  /**
   * The model with every row, section and list that did not change since the
   * previous call replaced by its previous object.
   */
  readonly share: (model: InboxSidebarModel) => InboxSidebarModel;
}

/**
 * The builder returns fresh rows on every run, so a memoized row would still
 * re-render for each of them. One instance per mounted inbox keeps unchanged
 * rows identical across runs; rows that left the model are forgotten.
 */
export function createInboxSidebarModelSharing(): InboxSidebarModelSharing {
  let rowsByKey = new Map<string, InboxSidebarRow>();
  let sectionsByKey = new Map<InboxSidebarSectionKey, InboxSidebarSection>();
  let previousModel: InboxSidebarModel | null = null;

  return {
    share(model) {
      const nextRowsByKey = new Map<string, InboxSidebarRow>();
      const shareRow = (row: InboxSidebarRow): InboxSidebarRow => {
        const candidate =
          row.delegatedChildren.length === 0
            ? row
            : { ...row, delegatedChildren: row.delegatedChildren.map(shareRow) };
        const previous = rowsByKey.get(row.key);
        const shared =
          previous !== undefined && sameInboxRow(previous, candidate) ? previous : candidate;
        nextRowsByKey.set(row.key, shared);
        return shared;
      };

      const nextSectionsByKey = new Map<InboxSidebarSectionKey, InboxSidebarSection>();
      const sections = model.sections.map((section) => {
        const rows = section.rows.map(shareRow);
        const previous = sectionsByKey.get(section.key);
        const shared =
          previous !== undefined &&
          previous.title === section.title &&
          sameElements(previous.rows, rows)
            ? previous
            : { ...section, rows };
        nextSectionsByKey.set(section.key, shared);
        return shared;
      });
      const sharedSections =
        previousModel !== null && sameElements(previousModel.sections, sections)
          ? previousModel.sections
          : sections;

      const shared =
        previousModel !== null &&
        previousModel.sections === sharedSections &&
        previousModel.nextSettlementEvaluationAtMs === model.nextSettlementEvaluationAtMs
          ? previousModel
          : { ...model, sections: sharedSections };
      rowsByKey = nextRowsByKey;
      sectionsByKey = nextSectionsByKey;
      previousModel = shared;
      return shared;
    },
  };
}

/**
 * Whether two provider lists label models identically for the inbox. The inbox
 * reads only each provider's instance id, driver and model catalog (see
 * `modelDisplayName`); status-only provider pushes keep the catalog's identity,
 * so treating them as equal skips rebuilding the whole inbox model.
 */
export function sameInboxProviderCatalogs(
  left: ReadonlyArray<ServerProvider> | null,
  right: ReadonlyArray<ServerProvider> | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null || left.length !== right.length) return false;
  return left.every((provider, index) => {
    const other = right[index]!;
    return (
      provider.instanceId === other.instanceId &&
      provider.driver === other.driver &&
      provider.models === other.models
    );
  });
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
