import { deriveThreadActivityStatus } from "@ryco/client-runtime/state/threads";
import type {
  Project,
  SidebarThreadSummary,
  SidebarWorktreeSummary,
  ThreadInboxMutationBlocker,
} from "@ryco/client-runtime/state/threads";
import { buildThreadInbox } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import type { SidebarAutoSettleAfterDays } from "@ryco/contracts/settings";
import type { ThreadSettlementBlocker } from "@ryco/shared/threadSettlement";
import {
  describeThreadPriorityFocus,
  type ThreadPriorityFocusMetadata,
} from "@ryco/shared/threadPriority";

import { buildChangeRequestBadge, type ChangeRequestBadge } from "../../lib/changeRequestBadge";
import {
  builtInProviderDriverForInstanceId,
  providerDisplayLabel,
} from "../../lib/providerDisplay";
import { type NodeTrust } from "../home/nodeTrustModel";

export type InboxThreadState =
  | "needs-input"
  | "delivery-unknown"
  | "working"
  | "connecting"
  | "error"
  | "reconnecting"
  | "offline"
  | "idle"
  | "settled";

export interface InboxEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connectionState: "connected" | "reconnecting" | "offline" | "read-only";
  /**
   * Wave 2: set when this environment's rows are cache-provenance — hydrated
   * from the snapshot cache or demoted after disconnect, with no live snapshot
   * since. Stale rows render as last-known state, never as live, with
   * `staleDetail` carrying the Hub-presence-derived "Offline · last seen" text.
   */
  readonly stale?: boolean;
  readonly staleDetail?: string;
  /**
   * Wave 4: the effective role on this environment — the hosted/roster role, or
   * the direct plane's `"client"` / `"owner"`. Absent when the plane reports
   * none; it is never defaulted, because "no role known" and "viewer" differ in
   * exactly what the user may do.
   */
  readonly role?: "viewer" | "operator" | "owner" | "client";
  /**
   * Wave 4: per-node E2EE trust, DISPLAY ONLY (see `nodeTrustModel.ts`). Absent
   * whenever this device has no evidence to claim from — never defaulted to
   * `"unverified"`, which would be a fabricated claim.
   */
  readonly trust?: NodeTrust;
  /** Wave 3b: this environment, not the whole app, has an unconfirmed send. */
  readonly deliveryUnknown?: boolean;
  readonly threadSettlementSupported?: boolean;
  readonly threadSnoozeSupported?: boolean;
  readonly mutationReady?: boolean;
  readonly shellCurrent?: boolean;
}

export interface InboxThreadRow {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly nodeLabel: string;
  readonly projectLabel: string;
  readonly project: Project | null;
  readonly isWorktree: boolean;
  readonly worktreeLabel: string;
  readonly contextLabel: string;
  readonly state: InboxThreadState;
  readonly statusLabel: string;
  readonly updatedAt: string;
  /**
   * The worktree's pull request / work item, when it has one. Last known state
   * — nothing refreshes it in the background. See changeRequestBadge.ts.
   */
  readonly changeRequest: ChangeRequestBadge | null;
  /**
   * Wave 4: a quiet neutral marker, surfaced only for `viewer` — the one role
   * that changes what the user may do here. Owner and operator render nothing;
   * a badge on every row would be provenance turned into noise. The word
   * matches HubNodeSection's `ROLE_LABELS`.
   */
  readonly roleLabel: "Viewer" | null;
  /** Current provider brand for the task; null renders the neutral mark. */
  readonly providerDriver: string | null;
  readonly providerLabel: string | null;
  readonly focus: ThreadPriorityFocusMetadata | null;
  readonly focusTitle: string | null;
  readonly focusDetail: string | null;
  readonly focusAiGenerated: boolean;
  readonly attentionState: "active" | "settled" | "snoozed";
  readonly snoozedUntil?: string | null;
  readonly canSnooze?: boolean;
  readonly canUnsnooze?: boolean;
  readonly canSettle: boolean;
  readonly settlementBlocker: ThreadSettlementBlocker | null;
  readonly mutationEnabled: boolean;
  readonly mutationBlocker: ThreadInboxMutationBlocker | null;
}

export interface InboxSection {
  readonly key: "focus" | "active" | "settled" | "snoozed";
  readonly title: "Focus" | "Active" | "Settled" | "Snoozed";
  readonly rows: ReadonlyArray<InboxThreadRow>;
}

export interface BuildInboxInput {
  readonly projects: ReadonlyArray<Project>;
  readonly worktrees: ReadonlyArray<SidebarWorktreeSummary>;
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
  readonly environments: ReadonlyArray<InboxEnvironment>;
  readonly nodeScope?: EnvironmentId | null;
  readonly query?: string;
  readonly deliveryUnknownThreadIds?: ReadonlySet<string>;
  readonly localQueuedThreadIds?: ReadonlySet<string>;
  readonly pinnedThreadKeys?: ReadonlySet<string> | ReadonlyArray<string>;
  readonly aiFocusEnabled?: boolean;
  readonly autoSettleAfterDays?: SidebarAutoSettleAfterDays;
  readonly nowMs?: number;
}

function scopedKey(environmentId: EnvironmentId, id: string): string {
  return `${environmentId}:${id}`;
}

function threadState(
  thread: SidebarThreadSummary,
  environment: InboxEnvironment | undefined,
  deliveryUnknownThreadIds: ReadonlySet<string>,
): InboxThreadState {
  // A stale environment's rows are last-known state: nothing on them may
  // present as live activity (or as actionable), whatever the cached fields
  // claim. Sourced from Hub presence via the environment row, not WS status.
  if (environment?.stale) return "offline";
  const activity = deriveThreadActivityStatus(thread);
  if (activity === "approval" || activity === "input" || activity === "plan-ready")
    return "needs-input";
  if (
    environment?.deliveryUnknown === true ||
    deliveryUnknownThreadIds.has(scopedKey(thread.environmentId, thread.id))
  ) {
    return "delivery-unknown";
  }
  if (environment?.connectionState === "offline") return "offline";
  if (activity === "working") return "working";
  if (activity === "connecting") return "connecting";
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") return "error";
  if (environment?.connectionState === "reconnecting") return "reconnecting";
  return "idle";
}

function statusLabel(state: InboxThreadState): string {
  switch (state) {
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
      return "Offline";
    case "idle":
      return "Idle";
    case "settled":
      return "Settled";
  }
}

function timestamp(thread: SidebarThreadSummary): string {
  return thread.updatedAt ?? thread.latestUserMessageAt ?? thread.createdAt;
}

export function buildInboxSections(input: BuildInboxInput): ReadonlyArray<InboxSection> {
  const environmentById = new Map(
    input.environments.map((environment) => [environment.environmentId, environment] as const),
  );
  const deliveryUnknown = new Set(input.deliveryUnknownThreadIds);
  for (const thread of input.threads) {
    if (environmentById.get(thread.environmentId)?.deliveryUnknown) {
      deliveryUnknown.add(scopedKey(thread.environmentId, thread.id));
    }
  }
  const inbox = buildThreadInbox({
    projects: input.projects,
    worktrees: input.worktrees,
    threads: input.threads,
    environments: input.environments.map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
      threadSettlementSupported: environment.threadSettlementSupported ?? false,
      threadSnoozeSupported: environment.threadSnoozeSupported ?? false,
      connected: environment.connectionState === "connected",
      mutationReady: environment.mutationReady ?? false,
      shellCurrent: environment.shellCurrent ?? false,
    })),
    localQueuedThreadKeys: input.localQueuedThreadIds,
    deliveryUnknownThreadKeys: deliveryUnknown,
    pinnedThreadKeys: input.pinnedThreadKeys,
    aiFocusEnabled: input.aiFocusEnabled ?? false,
    autoSettleAfterDays: input.autoSettleAfterDays,
    filters: {
      ...(input.nodeScope ? { environmentIds: [input.nodeScope] } : {}),
      text: input.query,
    },
    nowMs: input.nowMs ?? Date.now(),
  });

  const toRow = (entry: (typeof inbox.active)[number]): InboxThreadRow => {
    const thread = entry.thread!;
    const environment = environmentById.get(thread.environmentId);
    const nodeLabel = environment?.label || "Unknown machine";
    const projectLabel = entry.project?.name || "Unknown project";
    const worktreeLabel =
      entry.worktree?.title || entry.worktree?.branch || thread.branch || "Local workspace";
    const contextLabel = `${nodeLabel} · ${projectLabel} · ${worktreeLabel}`;
    const state =
      environment?.stale ||
      (environment?.connectionState === "offline" && !deliveryUnknown.has(entry.key))
        ? "offline"
        : entry.lifecycle.classification === "settled"
          ? "settled"
          : threadState(thread, environment, deliveryUnknown);
    const providerDriver =
      thread.session?.provider ??
      thread.providerDriver ??
      builtInProviderDriverForInstanceId(thread.modelSelection?.instanceId);
    const focusExplanation = entry.focus === null ? null : describeThreadPriorityFocus(entry.focus);
    return {
      key: entry.key,
      environmentId: thread.environmentId,
      threadId: thread.id,
      title: entry.title || "Untitled task",
      nodeLabel,
      projectLabel,
      project: entry.project,
      isWorktree: Boolean(entry.worktree?.worktreePath ?? thread.worktreePath),
      worktreeLabel,
      contextLabel,
      state,
      statusLabel:
        state === "offline" ? (environment?.staleDetail ?? "Offline") : statusLabel(state),
      updatedAt: entry.lifecycle.effectiveSettlementTimestamp ?? timestamp(thread),
      changeRequest: buildChangeRequestBadge(entry.worktree),
      roleLabel: environment?.role === "viewer" ? "Viewer" : null,
      providerDriver,
      providerLabel: providerDisplayLabel(providerDriver),
      focus: entry.focus,
      focusTitle: focusExplanation?.title ?? null,
      focusDetail: focusExplanation?.detail ?? null,
      focusAiGenerated: focusExplanation?.aiGenerated ?? false,
      attentionState: entry.lifecycle.classification,
      snoozedUntil:
        entry.lifecycle.classification === "snoozed" ? (thread.snoozedUntil ?? null) : null,
      canSnooze: entry.canSnooze,
      canUnsnooze:
        environment?.threadSnoozeSupported === true &&
        environment.mutationReady === true &&
        environment.shellCurrent === true &&
        environment.connectionState === "connected",
      canSettle: entry.lifecycle.eligibility.canSettle,
      settlementBlocker: entry.lifecycle.settlementBlocker,
      mutationEnabled: entry.mutationEnabled,
      mutationBlocker: entry.mutationBlocker,
    };
  };

  const focus = inbox.focus.map(toRow);
  const active = inbox.active.map(toRow);
  const settled = inbox.settled.map(toRow);
  const snoozed = inbox.snoozed.map(toRow);

  const sections: InboxSection[] = [];
  if (focus.length > 0) sections.push({ key: "focus", title: "Focus", rows: focus });
  if (active.length > 0) sections.push({ key: "active", title: "Active", rows: active });
  if (snoozed.length > 0) sections.push({ key: "snoozed", title: "Snoozed", rows: snoozed });
  if (settled.length > 0) sections.push({ key: "settled", title: "Settled", rows: settled });
  return sections;
}

export type InboxEmptyState = "connect-node" | "add-project" | "new-task" | "clear-filter" | null;

export function resolveInboxEmptyState(input: {
  readonly environmentCount: number;
  readonly projectCount: number;
  readonly threadCount: number;
  readonly hasFilter: boolean;
}): InboxEmptyState {
  if (input.environmentCount === 0) return "connect-node";
  if (input.projectCount === 0) return "add-project";
  if (input.threadCount === 0) return "new-task";
  if (input.hasFilter) return "clear-filter";
  return null;
}
