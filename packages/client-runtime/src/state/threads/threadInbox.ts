import { canSnoozeThread, isThreadSnoozed } from "@ryco/shared/threadSnooze";
import { deriveThreadActivityStatus } from "./threadActivityStatus.ts";
import type {
  EnvironmentId,
  ProjectId,
  ScopedThreadRef,
  SidebarAutoSettleAfterDays,
  ThreadId,
  WorktreeId,
} from "@ryco/contracts";
import {
  resolveAutoSettleAfterDays,
  canSettleThread,
  classifyThreadSettlement,
  compareActiveInboxEntries,
  compareSettledInboxEntries,
  getEffectiveSettlementTimestamp,
  getNextThreadSettlementEvaluationAtMs,
  type CanSettleThreadResult,
  type ThreadSettlementBlocker,
  type ThreadSettlementClassification,
  type ThreadSettlementInput,
} from "@ryco/shared/threadSettlement";
import {
  partitionThreadPriorities,
  type ThreadPriorityFocusMetadata,
} from "@ryco/shared/threadPriority";

import { scopeThreadRef, scopedProjectKey, scopedThreadKey } from "../../scoped.ts";
import type { Project, SidebarThreadSummary, SidebarWorktreeSummary } from "./types.ts";

export interface ThreadInboxEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly threadSettlementSupported: boolean;
  readonly threadSnoozeSupported?: boolean | undefined;
  readonly connected: boolean;
  readonly mutationReady: boolean;
  readonly shellCurrent: boolean;
}

export interface ThreadInboxDraftSummary {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly createdAt: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly worktreeId?: WorktreeId | null | undefined;
  readonly promotedTo?: ScopedThreadRef | null | undefined;
}

export interface ThreadInboxFilters {
  readonly environmentIds?: ReadonlyArray<EnvironmentId> | undefined;
  readonly projectKeys?: ReadonlyArray<string> | undefined;
  readonly worktreeKeys?: ReadonlyArray<string> | undefined;
  readonly text?: string | undefined;
}

export type ThreadInboxMutationBlocker =
  | "client-draft"
  | "unsupported"
  | "disconnected"
  | "read-only"
  | "shell-stale";

export interface ThreadInboxLifecycle {
  readonly classification: Exclude<ThreadSettlementClassification, "excluded"> | "snoozed";
  readonly eligibility: CanSettleThreadResult;
  readonly effectiveSettlementTimestamp: string | null;
  readonly settlementBlocker: ThreadSettlementBlocker | null;
}

export interface ThreadInboxEntry {
  readonly key: string;
  readonly ref: ScopedThreadRef;
  readonly thread: SidebarThreadSummary | null;
  readonly draft: ThreadInboxDraftSummary | null;
  readonly title: string;
  readonly createdAt: string;
  readonly project: Project | null;
  readonly worktree: SidebarWorktreeSummary | null;
  readonly environment: ThreadInboxEnvironment;
  readonly lifecycle: ThreadInboxLifecycle;
  readonly mutationEnabled: boolean;
  readonly mutationBlocker: ThreadInboxMutationBlocker | null;
  readonly pinned: boolean;
  readonly current: boolean;
  readonly isDraft: boolean;
  readonly canSnooze: boolean;
  readonly focus: ThreadPriorityFocusMetadata | null;
}

export interface BuildThreadInboxInput {
  readonly projects: ReadonlyArray<Project>;
  readonly worktrees: ReadonlyArray<SidebarWorktreeSummary>;
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
  readonly environments: ReadonlyArray<ThreadInboxEnvironment>;
  readonly pinnedThreadKeys?: ReadonlySet<string> | ReadonlyArray<string> | undefined;
  readonly localQueuedThreadKeys?: ReadonlySet<string> | ReadonlyArray<string> | undefined;
  readonly deliveryUnknownThreadKeys?: ReadonlySet<string> | ReadonlyArray<string> | undefined;
  readonly drafts?: ReadonlyArray<ThreadInboxDraftSummary> | undefined;
  readonly filters?: ThreadInboxFilters | undefined;
  readonly currentThreadKey?: string | null | undefined;
  readonly aiFocusEnabled?: boolean | undefined;
  readonly autoSettleAfterDays?: SidebarAutoSettleAfterDays | undefined;
  readonly nowMs: number;
}

export interface ThreadInboxModel {
  readonly focus: ThreadInboxEntry[];
  readonly active: ThreadInboxEntry[];
  readonly settled: ThreadInboxEntry[];
  readonly snoozed: ThreadInboxEntry[];
  readonly excludedCount: number;
  readonly nextSettlementEvaluationAtMs: number | null;
}

export function scopedInboxWorktreeKey(
  environmentId: EnvironmentId,
  worktreeId: WorktreeId,
): string {
  return `${environmentId}:${worktreeId}`;
}

function toKeySet(
  values: ReadonlySet<string> | ReadonlyArray<string> | undefined,
): ReadonlySet<string> {
  return values instanceof Set ? values : new Set(values ?? []);
}

function fallbackEnvironment(environmentId: EnvironmentId): ThreadInboxEnvironment {
  return {
    environmentId,
    label: environmentId,
    threadSettlementSupported: false,
    connected: false,
    mutationReady: false,
    shellCurrent: false,
  };
}

function resolveWorktree(input: {
  readonly thread: Pick<
    SidebarThreadSummary,
    "environmentId" | "projectId" | "worktreeId" | "worktreePath"
  >;
  readonly worktreeByKey: ReadonlyMap<string, SidebarWorktreeSummary>;
  readonly worktreesByProjectKey: ReadonlyMap<string, ReadonlyArray<SidebarWorktreeSummary>>;
}): SidebarWorktreeSummary | null {
  if (input.thread.worktreeId) {
    return (
      input.worktreeByKey.get(
        scopedInboxWorktreeKey(input.thread.environmentId, input.thread.worktreeId as WorktreeId),
      ) ?? null
    );
  }
  if (input.thread.worktreePath === null) {
    return null;
  }
  return (
    input.worktreesByProjectKey
      .get(
        scopedProjectKey({
          environmentId: input.thread.environmentId,
          projectId: input.thread.projectId,
        }),
      )
      ?.find((worktree) => worktree.worktreePath === input.thread.worktreePath) ?? null
  );
}

function mutationBlocker(
  environment: ThreadInboxEnvironment,
  isDraft: boolean,
): ThreadInboxMutationBlocker | null {
  if (isDraft) return "client-draft";
  if (!environment.threadSettlementSupported) return "unsupported";
  if (!environment.connected) return "disconnected";
  if (!environment.shellCurrent) return "shell-stale";
  if (!environment.mutationReady) return "read-only";
  return null;
}

function settlementInput(input: {
  readonly thread: SidebarThreadSummary;
  readonly worktree: SidebarWorktreeSummary | null;
  readonly environment: ThreadInboxEnvironment;
  readonly hasLocalQueuedMessage: boolean;
  readonly deliveryUnknown: boolean;
  readonly autoSettleAfterDays: SidebarAutoSettleAfterDays;
  readonly nowMs: number;
}): ThreadSettlementInput {
  return {
    threadSettlementSupported: input.environment.threadSettlementSupported,
    archivedAt: input.thread.archivedAt,
    deletedAt: null,
    worktreeArchivedAt: input.worktree?.archivedAt ?? null,
    settledOverride: input.thread.settledOverride ?? null,
    settledAt: input.thread.settledAt ?? null,
    sessionStatus: input.thread.session?.orchestrationStatus ?? null,
    latestTurnState: input.thread.latestTurn?.state ?? null,
    latestTurnRequestedAt: input.thread.latestTurn?.requestedAt ?? null,
    latestTurnStartedAt: input.thread.latestTurn?.startedAt ?? null,
    latestTurnCompletedAt: input.thread.latestTurn?.completedAt ?? null,
    latestUserMessageAt: input.thread.latestUserMessageAt,
    hasPendingApprovals: input.thread.hasPendingApprovals,
    hasPendingUserInput:
      input.thread.hasPendingUserInput || deriveThreadActivityStatus(input.thread) === "plan-ready",
    hasLocalQueuedMessage: input.hasLocalQueuedMessage,
    deliveryUnknown: input.deliveryUnknown,
    prState: input.worktree?.prState ?? null,
    worktreeUpdatedAt: input.worktree?.updatedAt ?? null,
    updatedAt: input.thread.updatedAt ?? null,
    createdAt: input.thread.createdAt,
    autoSettleAfterDays: input.autoSettleAfterDays,
    nowMs: input.nowMs,
  };
}

function filterEntry(entry: ThreadInboxEntry, filters: ThreadInboxFilters | undefined): boolean {
  if (!filters) return true;
  if (filters.environmentIds && !filters.environmentIds.includes(entry.environment.environmentId)) {
    return false;
  }
  if (
    filters.projectKeys &&
    !filters.projectKeys.includes(
      scopedProjectKey({
        environmentId: entry.ref.environmentId,
        projectId: entry.project?.id ?? entry.thread?.projectId ?? entry.draft!.projectId,
      }),
    )
  ) {
    return false;
  }
  if (filters.worktreeKeys) {
    if (
      entry.worktree === null ||
      !filters.worktreeKeys.includes(
        scopedInboxWorktreeKey(entry.environment.environmentId, entry.worktree.id),
      )
    ) {
      return false;
    }
  }

  const text = filters.text?.trim().toLocaleLowerCase();
  if (!text) return true;
  return [
    entry.title,
    entry.environment.label,
    entry.project?.name,
    entry.project?.cwd,
    entry.worktree?.title,
    entry.worktree?.branch,
    entry.worktree?.prTitle,
    entry.worktree?.issueTitle,
    entry.worktree?.workItemKey,
    entry.worktree?.workItemTitle,
  ].some((value) => value?.toLocaleLowerCase().includes(text) === true);
}

function createDraftThreadSummary(draft: ThreadInboxDraftSummary): SidebarThreadSummary {
  return {
    id: draft.threadId,
    environmentId: draft.environmentId,
    projectId: draft.projectId,
    title: draft.title,
    interactionMode: "default",
    session: null,
    createdAt: draft.createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestTurn: null,
    branch: draft.branch,
    worktreePath: draft.worktreePath,
    worktreeId: draft.worktreeId ?? null,
    manualStatusBucket: null,
    manualPosition: 0,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

export function buildThreadInbox(input: BuildThreadInboxInput): ThreadInboxModel {
  const pinnedKeys = toKeySet(input.pinnedThreadKeys);
  const localQueueKeys = toKeySet(input.localQueuedThreadKeys);
  const deliveryUnknownKeys = toKeySet(input.deliveryUnknownThreadKeys);
  const environmentById = new Map(
    input.environments.map((environment) => [environment.environmentId, environment] as const),
  );
  const projectByKey = new Map(
    input.projects.map(
      (project) =>
        [
          scopedProjectKey({ environmentId: project.environmentId, projectId: project.id }),
          project,
        ] as const,
    ),
  );
  const worktreeByKey = new Map(
    input.worktrees.map(
      (worktree) =>
        [scopedInboxWorktreeKey(worktree.environmentId, worktree.id), worktree] as const,
    ),
  );
  const worktreesByProjectKey = new Map<string, SidebarWorktreeSummary[]>();
  for (const worktree of input.worktrees) {
    const key = scopedProjectKey({
      environmentId: worktree.environmentId,
      projectId: worktree.projectId,
    });
    worktreesByProjectKey.set(key, [...(worktreesByProjectKey.get(key) ?? []), worktree]);
  }
  const serverThreadKeys = new Set(
    input.threads.map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
  );

  let excludedCount = 0;
  let nextSettlementEvaluationAtMs: number | null = null;
  const entries: ThreadInboxEntry[] = [];
  for (const thread of input.threads) {
    const ref = scopeThreadRef(thread.environmentId, thread.id);
    const key = scopedThreadKey(ref);
    const environment =
      environmentById.get(thread.environmentId) ?? fallbackEnvironment(thread.environmentId);
    const project =
      projectByKey.get(
        scopedProjectKey({
          environmentId: thread.environmentId,
          projectId: thread.projectId,
        }),
      ) ?? null;
    const worktree = resolveWorktree({ thread, worktreeByKey, worktreesByProjectKey });
    const policyInput = settlementInput({
      thread,
      worktree,
      environment,
      hasLocalQueuedMessage: localQueueKeys.has(key),
      deliveryUnknown: deliveryUnknownKeys.has(key),
      autoSettleAfterDays: resolveAutoSettleAfterDays(input.autoSettleAfterDays),
      nowMs: input.nowMs,
    });
    const nextEvaluationAtMs = getNextThreadSettlementEvaluationAtMs(policyInput);
    if (
      nextEvaluationAtMs !== null &&
      (nextSettlementEvaluationAtMs === null || nextEvaluationAtMs < nextSettlementEvaluationAtMs)
    ) {
      nextSettlementEvaluationAtMs = nextEvaluationAtMs;
    }
    const classification = classifyThreadSettlement(policyInput);
    if (classification === "excluded") {
      excludedCount += 1;
      continue;
    }
    const snoozed =
      isThreadSnoozed(thread, input.nowMs) &&
      !policyInput.hasLocalQueuedMessage &&
      !policyInput.deliveryUnknown;
    if (snoozed) {
      const wake = Date.parse(thread.snoozedUntil!);
      nextSettlementEvaluationAtMs = Math.min(nextSettlementEvaluationAtMs ?? wake, wake);
    }
    const eligibility = canSettleThread(policyInput);
    const blocker = mutationBlocker(environment, false);
    entries.push({
      key,
      ref,
      thread,
      draft: null,
      title: thread.title,
      createdAt: thread.createdAt,
      project,
      worktree,
      environment,
      lifecycle: {
        classification: snoozed ? "snoozed" : classification,
        eligibility,
        effectiveSettlementTimestamp: getEffectiveSettlementTimestamp(policyInput),
        settlementBlocker: eligibility.blocker,
      },
      mutationEnabled: blocker === null,
      mutationBlocker: blocker,
      pinned: pinnedKeys.has(key),
      current: input.currentThreadKey === key,
      isDraft: false,
      canSnooze:
        environment.threadSnoozeSupported === true &&
        environment.connected &&
        environment.shellCurrent &&
        environment.mutationReady &&
        canSnoozeThread(policyInput).canSnooze,
      focus: null,
    });
  }

  for (const draft of input.drafts ?? []) {
    const promotedKey = draft.promotedTo ? scopedThreadKey(draft.promotedTo) : null;
    if (promotedKey !== null && serverThreadKeys.has(promotedKey)) {
      continue;
    }
    const ref = draft.promotedTo ?? scopeThreadRef(draft.environmentId, draft.threadId);
    const key = scopedThreadKey(ref);
    if (serverThreadKeys.has(key)) {
      continue;
    }
    const environment =
      environmentById.get(draft.environmentId) ?? fallbackEnvironment(draft.environmentId);
    const thread = createDraftThreadSummary(draft);
    const project =
      projectByKey.get(
        scopedProjectKey({
          environmentId: draft.environmentId,
          projectId: draft.projectId,
        }),
      ) ?? null;
    const worktree = resolveWorktree({ thread, worktreeByKey, worktreesByProjectKey });
    entries.push({
      key,
      ref,
      thread: null,
      draft,
      title: draft.title,
      createdAt: draft.createdAt,
      project,
      worktree,
      environment,
      lifecycle: {
        classification: "active",
        eligibility: { canSettle: false, blocker: "unsupported" },
        effectiveSettlementTimestamp: null,
        settlementBlocker: "unsupported",
      },
      mutationEnabled: false,
      mutationBlocker: "client-draft",
      pinned: pinnedKeys.has(key),
      current: input.currentThreadKey === key,
      isDraft: true,
      canSnooze: false,
      focus: null,
    });
  }

  const visibleEntries = entries.filter(
    (entry) => entry.current || filterEntry(entry, input.filters),
  );
  const active = visibleEntries
    .filter((entry) => entry.lifecycle.classification === "active")
    .toSorted((left, right) =>
      compareActiveInboxEntries(
        { scopedKey: left.key, pinned: left.pinned, createdAt: left.createdAt },
        { scopedKey: right.key, pinned: right.pinned, createdAt: right.createdAt },
      ),
    );
  const priorityPartition = partitionThreadPriorities({
    active,
    enabled: input.aiFocusEnabled ?? false,
    nowMs: input.nowMs,
    toCandidate: (entry) => ({
      scopedKey: entry.key,
      pinned: entry.pinned,
      serverOwned: !entry.isDraft,
      hasPendingApprovals: entry.thread?.hasPendingApprovals ?? false,
      hasPendingUserInput: entry.thread?.hasPendingUserInput ?? false,
      latestTurn: entry.thread?.latestTurn ?? null,
      latestUserMessageAt: entry.thread?.latestUserMessageAt ?? null,
      priority: entry.thread?.priority,
    }),
  });

  return {
    snoozed: visibleEntries
      .filter((entry) => entry.lifecycle.classification === "snoozed")
      .toSorted((left, right) =>
        (left.thread?.snoozedUntil ?? "").localeCompare(right.thread?.snoozedUntil ?? ""),
      ),
    focus: priorityPartition.focus.map(({ value, focus }) => ({ ...value, focus })),
    active: [...priorityPartition.active],
    settled: visibleEntries
      .filter((entry) => entry.lifecycle.classification === "settled")
      .toSorted((left, right) =>
        compareSettledInboxEntries(
          {
            scopedKey: left.key,
            effectiveSettlementTimestamp: left.lifecycle.effectiveSettlementTimestamp,
            createdAt: left.createdAt,
          },
          {
            scopedKey: right.key,
            effectiveSettlementTimestamp: right.lifecycle.effectiveSettlementTimestamp,
            createdAt: right.createdAt,
          },
        ),
      ),
    excludedCount,
    nextSettlementEvaluationAtMs,
  };
}
