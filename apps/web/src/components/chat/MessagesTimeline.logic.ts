import {
  formatDuration,
  type ContextCompactionTimelineEntry,
  type ContextHandoffTimelineEntry,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import type { AgentPanelModel } from "../../threadWorkspaceViewModel";
import { deriveDisplayedUserMessageState } from "../../lib/terminalContext";
import {
  isChatImageAttachment,
  type ChatAttachment,
  type ChatMessage,
  type ProposedPlan,
  type TurnDiffSummary,
} from "../../types";
import {
  type EnvironmentId,
  type MessageId,
  type OrchestrationLatestTurn,
  type ServerProviderSkill,
  type TurnId,
} from "@ryco/contracts";
import { type TimestampFormat } from "@ryco/contracts/settings";
import { type ExpandedImagePreview } from "./ExpandedImagePreview";
import type { ThreadMessageSearchOccurrence } from "./ThreadMessageSearch.logic";
import { summarizeToolCallGroup, type ToolCallGroupSummary } from "./toolCallGroup.logic";

const MIN_COLLAPSIBLE_WORK_LOG_ENTRIES = 2;
export const TIMELINE_MINIMAP_ITEM_SPACING = 8;
export const TIMELINE_MINIMAP_MIN_ITEMS = 2;
export const TIMELINE_MINIMAP_MAX_HEIGHT_CSS = "calc(100vh - 18rem)";
export const TIMELINE_CONTENT_MAX_WIDTH = 768;
export const TIMELINE_MINIMAP_PERSISTENT_GUTTER = 48;
export const TIMELINE_MINIMAP_HIT_STRIP_LEFT = 12;
export const TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH = 40;
export const TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH = "22rem";
const TIMELINE_MINIMAP_PREVIEW_MAX_LENGTH = 240;

export interface TimelineMinimapItem {
  readonly id: string;
  readonly rowIndex: number;
  readonly userText: string | null;
  readonly assistantText: string | null;
}

export function resolveTimelineMinimapHeightStyle(itemCount: number): string {
  const naturalHeight = Math.max(1, (itemCount - 1) * TIMELINE_MINIMAP_ITEM_SPACING);
  return `min(${naturalHeight}px, ${TIMELINE_MINIMAP_MAX_HEIGHT_CSS})`;
}

export function resolveTimelineMinimapTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) {
    return 0;
  }
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100;
}

export function resolveTimelineMinimapIndexFromPointer(input: {
  readonly itemCount: number;
  readonly railTop: number;
  readonly railHeight: number;
  readonly pointerY: number;
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) {
    return null;
  }
  if (input.itemCount === 1) {
    return 0;
  }

  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight));
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))));
}

export function resolveTimelineMinimapHasPersistentGutter(viewportWidth: number): boolean {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return false;
  }

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH);
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return sideGutter >= TIMELINE_MINIMAP_PERSISTENT_GUTTER;
}

/**
 * The minimap overlays the viewport's left edge while the content column is
 * centered. Cap the collapsed hover strip to the side gutter so it cannot
 * intercept pointer events over message text under zoom or in a narrow pane.
 */
export function resolveTimelineMinimapHitStripWidth(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return 0;
  }

  const contentWidth = Math.min(viewportWidth, TIMELINE_CONTENT_MAX_WIDTH);
  const sideGutter = Math.max(0, (viewportWidth - contentWidth) / 2);
  return Math.max(
    0,
    Math.min(
      TIMELINE_MINIMAP_HIT_STRIP_MAX_WIDTH,
      Math.floor(sideGutter) - TIMELINE_MINIMAP_HIT_STRIP_LEFT,
    ),
  );
}

/**
 * Fraction of the viewport within which the transcript counts as "at the end".
 * Mirrors LegendList's `maintainScrollAtEndThreshold`, so the scroll-to-bottom
 * pill is hidden exactly while the list still auto-pins to the bottom.
 */
export const TIMELINE_AT_END_THRESHOLD_RATIO = 0.1;

/** Sub-pixel slack when deciding whether the transcript can scroll at all. */
const TIMELINE_SCROLLABLE_EPSILON_PX = 1;

export interface TimelineScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/**
 * Whether the transcript is parked at the bottom — measured from the live
 * scroller rather than LegendList's cached `isAtEnd`, which only refreshes
 * inside its own layout/scroll passes and stays stale for a transcript that
 * never scrolls. A viewport that is unmeasured, or content that fits without
 * overflowing, both count as "at the end": there is no bottom to travel to,
 * so the scroll-to-bottom affordance has nothing to offer.
 */
export function isTimelineScrolledToEnd(metrics: TimelineScrollMetrics): boolean {
  const { scrollTop, scrollHeight, clientHeight } = metrics;
  if (
    !Number.isFinite(scrollTop) ||
    !Number.isFinite(scrollHeight) ||
    !Number.isFinite(clientHeight)
  ) {
    return true;
  }
  if (clientHeight <= 0) {
    return true;
  }
  if (scrollHeight - clientHeight <= TIMELINE_SCROLLABLE_EPSILON_PX) {
    return true;
  }
  const distanceFromEnd = scrollHeight - scrollTop - clientHeight;
  return distanceFromEnd < clientHeight * TIMELINE_AT_END_THRESHOLD_RATIO;
}

export function resolveTimelineMinimapInteractiveWidth(
  collapsedWidth: number,
  expanded: boolean,
): number | string {
  return expanded ? TIMELINE_MINIMAP_EXPANDED_HIT_STRIP_WIDTH : collapsedWidth;
}

// ---------------------------------------------------------------------------
// Timeline row context split — streaming-frequent vs stable fields.
// `MessagesTimeline` provides two separate React contexts so that streaming
// transitions (activeTurnInProgress / isWorking / …) do not invalidate the
// stable context value (theme/cwd/skills/timestampFormat/callbacks) consumed
// by rows that only depend on stable state.
// ---------------------------------------------------------------------------

/** Frequently changing state — updates across a turn's lifecycle. */
export interface TimelineStreamingState {
  activeTurnInProgress: boolean;
  activeTurnId: TurnId | null;
  isWorking: boolean;
  isRevertingCheckpoint: boolean;
  openDiffTurnId: TurnId | null;
  /** Shared agent fold, read at render time by spawn CTA rows (the CTA
   * itself never carries a roster; the Agents panel is the only roster). */
  agentPanelModel: AgentPanelModel;
}

/**
 * Long-press target payload for the phone message action sheet: which
 * message was pressed and which of the shared message actions apply to it.
 */
export interface TimelineMessageActionsRequest {
  messageId: MessageId;
  role: "user" | "assistant";
  copyText: string | null;
  canRevert: boolean;
}

/** Infrequently changing state — settings, per-thread context, and callbacks. */
export interface TimelineStableState {
  timestampFormat: TimestampFormat;
  routeThreadKey: string;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  workspaceRoot: string | undefined;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  activeThreadEnvironmentId: EnvironmentId;
  highlightedMessageId: MessageId | null;
  threadMessageSearchQuery: string;
  threadMessageSearchOccurrencesByMessageId: ReadonlyMap<
    MessageId,
    ReadonlyArray<ThreadMessageSearchOccurrence>
  >;
  activeThreadMessageSearchOccurrence: ThreadMessageSearchOccurrence | null;
  onRevertUserMessage: (messageId: MessageId) => void;
  onUndoTurn: (turnCount: number) => void;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onCloseDiff: () => void;
  onOpenAgents: () => void;
  onOpenMessageActions: (request: TimelineMessageActionsRequest) => void;
  onInspectContextHandoff?: (
    marker: ContextHandoffTimelineEntry,
    trigger: HTMLButtonElement,
  ) => void;
}

/**
 * Normalizes the streaming-frequent context value, copying only the streaming
 * fields. Excess keys (e.g. accidentally-passed stable fields) are dropped so
 * the streaming context never carries stable state that would broaden churn.
 */
export function buildTimelineStreamingState(input: TimelineStreamingState): TimelineStreamingState {
  return {
    activeTurnInProgress: input.activeTurnInProgress,
    activeTurnId: input.activeTurnId,
    isWorking: input.isWorking,
    isRevertingCheckpoint: input.isRevertingCheckpoint,
    openDiffTurnId: input.openDiffTurnId,
    agentPanelModel: input.agentPanelModel,
  };
}

/**
 * Normalizes the stable context value, copying only the stable fields. Excess
 * keys (e.g. accidentally-passed streaming fields) are dropped so the stable
 * context identity is unaffected by streaming transitions.
 */
export function buildTimelineStableState(input: TimelineStableState): TimelineStableState {
  return {
    timestampFormat: input.timestampFormat,
    routeThreadKey: input.routeThreadKey,
    markdownCwd: input.markdownCwd,
    resolvedTheme: input.resolvedTheme,
    workspaceRoot: input.workspaceRoot,
    skills: input.skills,
    activeThreadEnvironmentId: input.activeThreadEnvironmentId,
    highlightedMessageId: input.highlightedMessageId,
    threadMessageSearchQuery: input.threadMessageSearchQuery,
    threadMessageSearchOccurrencesByMessageId: input.threadMessageSearchOccurrencesByMessageId,
    activeThreadMessageSearchOccurrence: input.activeThreadMessageSearchOccurrence,
    onRevertUserMessage: input.onRevertUserMessage,
    onUndoTurn: input.onUndoTurn,
    onImageExpand: input.onImageExpand,
    onOpenTurnDiff: input.onOpenTurnDiff,
    onCloseDiff: input.onCloseDiff,
    onOpenAgents: input.onOpenAgents,
    onOpenMessageActions: input.onOpenMessageActions,
    ...(input.onInspectContextHandoff
      ? { onInspectContextHandoff: input.onInspectContextHandoff }
      : {}),
  };
}

export function isErroredWorkEntry(entry: WorkLogEntry): boolean {
  if (entry.tone === "error") return true;
  return entry.exitCode !== undefined && entry.exitCode !== 0;
}

export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  completedAt?: string | undefined;
}

export type MessagesTimelineRow =
  | {
      kind: "work";
      id: string;
      createdAt: string;
      groupedEntries: WorkLogEntry[];
    }
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: ChatMessage;
      durationStart: string;
      showAssistantCopyButton: boolean;
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      revertTurnCount?: number | undefined;
      /** Turn count to roll back to when undoing this assistant turn's edits. */
      assistantUndoTurnCount?: number | undefined;
    }
  | {
      kind: "turn-fold";
      id: string;
      createdAt: string;
      turnId: TurnId;
      foldId: string;
      status: "running" | "settled";
      durationStart: string | null;
      label: string | null;
      expanded: boolean;
    }
  | {
      kind: "work-toggle";
      id: string;
      createdAt: string;
      groupId: string;
      hiddenCount: number;
      expanded: boolean;
      onlyToolEntries: boolean;
      /** Compact recap of the folded run ("Ran 9 commands, Read 1 file"). */
      summary: ToolCallGroupSummary | null;
    }
  | {
      kind: "proposed-plan";
      id: string;
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      kind: "context-compaction";
      id: string;
      createdAt: string;
      marker: ContextCompactionTimelineEntry;
    }
  | {
      kind: "context-handoff";
      id: string;
      createdAt: string;
      marker: ContextHandoffTimelineEntry;
    }
  | { kind: "working"; id: string; createdAt: string | null };

export function deriveTimelineMinimapItems(
  rows: ReadonlyArray<MessagesTimelineRow>,
): TimelineMinimapItem[] {
  const items: TimelineMinimapItem[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message" || row.message.role !== "user") {
      continue;
    }

    items.push({
      id: row.id,
      rowIndex: index,
      userText: compactTimelineMinimapPreview(
        deriveDisplayedUserMessageState(row.message.text).visibleText,
      ),
      assistantText: compactTimelineMinimapPreview(
        resolveFinalAssistantTextForTimelineTurn(rows, index),
      ),
    });
  }

  return items;
}

function resolveFinalAssistantTextForTimelineTurn(
  rows: ReadonlyArray<MessagesTimelineRow>,
  userRowIndex: number,
): string | null {
  let finalAssistantText: string | null = null;

  for (let index = userRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message") {
      continue;
    }
    if (row.message.role === "user") {
      break;
    }
    if (row.message.role === "assistant") {
      finalAssistantText = row.message.text;
    }
  }

  return finalAssistantText;
}

function compactTimelineMinimapPreview(text: string | null | undefined): string | null {
  const compact = text?.replace(/\s+/g, " ").trim() ?? "";
  if (compact.length === 0) {
    return null;
  }
  if (compact.length <= TIMELINE_MINIMAP_PREVIEW_MAX_LENGTH) {
    return compact;
  }
  return `${compact.slice(0, TIMELINE_MINIMAP_PREVIEW_MAX_LENGTH - 1)}…`;
}

export interface StableMessagesTimelineRowsState {
  byId: Map<string, MessagesTimelineRow>;
  result: MessagesTimelineRow[];
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && message.completedAt) {
      lastBoundary = message.completedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

export function resolveAssistantMessageCopyState({
  text,
  showCopyButton,
  streaming,
}: {
  text: string | null;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const hasText = text !== null && text.trim().length > 0;
  return {
    text: hasText ? text : null,
    visible: showCopyButton && hasText && !streaming,
  };
}

function deriveTerminalAssistantMessageIds(timelineEntries: ReadonlyArray<TimelineEntry>) {
  const lastAssistantMessageIdByResponseKey = new Map<string, string>();
  let nullTurnResponseIndex = 0;

  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message") {
      continue;
    }
    const { message } = timelineEntry;
    if (message.role === "user") {
      nullTurnResponseIndex += 1;
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }

    const responseKey = message.turnId
      ? `turn:${message.turnId}`
      : `unkeyed:${nullTurnResponseIndex}`;
    lastAssistantMessageIdByResponseKey.set(responseKey, message.id);
  }

  return new Set(lastAssistantMessageIdByResponseKey.values());
}

export type TimelineLatestTurn = Pick<
  OrchestrationLatestTurn,
  "turnId" | "state" | "startedAt" | "completedAt"
>;

interface TurnFold {
  turnId: TurnId;
  foldId: string;
  createdAt: string;
  status: "running" | "settled";
  durationStart: string | null;
  label: string | null;
  hiddenEntryIds: ReadonlySet<string>;
  expanded: boolean;
}

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function maxIsoTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs)) return b;
  if (!Number.isFinite(bMs)) return a;
  return bMs > aMs ? b : a;
}

function deriveUnsettledTurnId(
  latestTurn: TimelineLatestTurn | null,
  runningTurnId: TurnId | null,
): TurnId | null {
  if (runningTurnId !== null) {
    return runningTurnId;
  }
  if (!latestTurn) {
    return null;
  }
  const isSettled = latestTurn.completedAt !== null && latestTurn.state !== "running";
  return isSettled ? null : latestTurn.turnId;
}

function timelineEntryTurnId(entry: TimelineEntry): TurnId | null {
  if (entry.kind === "message" && entry.message.role === "assistant") {
    return entry.message.turnId ?? null;
  }
  if (entry.kind === "work") {
    return entry.entry.turnId ?? null;
  }
  return null;
}

function timelineEntryEnd(entry: TimelineEntry): string {
  if (entry.kind === "message") {
    return entry.message.completedAt ?? entry.message.createdAt;
  }
  return entry.createdAt;
}

function deriveTurnFolds(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  terminalAssistantMessageIds: ReadonlySet<string>;
  latestTurn: TimelineLatestTurn | null;
  unsettledTurnId: TurnId | null;
  activeTurnStartedAt: string | null;
  turnFoldExpandedById: Readonly<Record<string, boolean>>;
}): ReadonlyMap<string, TurnFold> {
  interface TurnGroup {
    entries: TimelineEntry[];
    terminalEntry: Extract<TimelineEntry, { kind: "message" }> | null;
    hasStreamingMessage: boolean;
    startBoundary: string | null;
  }

  const groupsByTurnId = new Map<TurnId, TurnGroup>();
  let pendingUserBoundary: string | null = null;

  for (const entry of input.timelineEntries) {
    if (entry.kind === "message" && entry.message.role === "user") {
      pendingUserBoundary = entry.message.createdAt;
      continue;
    }
    const turnId = timelineEntryTurnId(entry);
    if (!turnId) continue;

    let group = groupsByTurnId.get(turnId);
    if (!group) {
      group = {
        entries: [],
        terminalEntry: null,
        hasStreamingMessage: false,
        startBoundary: pendingUserBoundary,
      };
      pendingUserBoundary = null;
      groupsByTurnId.set(turnId, group);
    }
    group.entries.push(entry);
    if (entry.kind === "message") {
      if (input.terminalAssistantMessageIds.has(entry.message.id)) {
        group.terminalEntry = entry;
      }
      group.hasStreamingMessage ||= entry.message.streaming;
    }
  }

  const foldsByAnchorEntryId = new Map<string, TurnFold>();
  for (const [turnId, group] of groupsByTurnId) {
    const isRunning = turnId === input.unsettledTurnId;
    if (!isRunning && group.hasStreamingMessage) continue;

    const hiddenEntryIds = new Set<string>();
    for (const entry of group.entries) {
      // Agent-spawn CTA rows never fold: workflows outlive their launching
      // turn (dynamic spawns, background execution), and folding the CTA
      // when the turn settles makes a still-running fleet invisible.
      if (entry.kind === "work" && entry.entry.agentSpawn !== undefined) {
        continue;
      }
      if (isRunning || entry.id !== group.terminalEntry?.id) {
        hiddenEntryIds.add(entry.id);
      }
    }
    if (hiddenEntryIds.size === 0) continue;

    const firstEntry = group.entries[0];
    const lastEntry = group.entries.at(-1);
    if (!firstEntry || !lastEntry) continue;

    const status = isRunning ? "running" : "settled";
    const foldId = `turn-fold:${status}:${turnId}`;
    const authoritativeStart =
      input.latestTurn?.turnId === turnId ? input.latestTurn.startedAt : null;
    const durationStart =
      authoritativeStart ??
      (isRunning ? input.activeTurnStartedAt : null) ??
      group.startBoundary ??
      firstEntry.createdAt;

    let label: string | null = null;
    if (!isRunning) {
      const authoritativeEnd =
        input.latestTurn?.turnId === turnId ? input.latestTurn.completedAt : null;
      const fallbackEnd =
        maxIsoTimestamp(
          group.terminalEntry ? timelineEntryEnd(group.terminalEntry) : null,
          timelineEntryEnd(lastEntry),
        ) ?? timelineEntryEnd(lastEntry);
      const elapsedMs = computeElapsedMs(durationStart, authoritativeEnd ?? fallbackEnd);
      const duration = elapsedMs === null ? null : formatDuration(elapsedMs);
      const interrupted =
        input.latestTurn?.turnId === turnId && input.latestTurn.state === "interrupted";
      label = interrupted
        ? duration
          ? `You stopped after ${duration}`
          : "You stopped this response"
        : duration
          ? `Worked for ${duration}`
          : "Worked";
    }

    foldsByAnchorEntryId.set(firstEntry.id, {
      turnId,
      foldId,
      createdAt: firstEntry.createdAt,
      status,
      durationStart,
      label,
      hiddenEntryIds,
      expanded: input.turnFoldExpandedById[foldId] ?? isRunning,
    });
  }
  return foldsByAnchorEntryId;
}

export function deriveRevertTurnCountByUserMessageId(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  inferredCheckpointTurnCountByTurnId: Readonly<Partial<Record<TurnDiffSummary["turnId"], number>>>;
}): Map<MessageId, number> {
  const byUserMessageId = new Map<MessageId, number>();
  let pendingUserMessageId: MessageId | null = null;

  for (const entry of input.timelineEntries) {
    if (entry.kind !== "message") {
      continue;
    }

    if (entry.message.role === "user") {
      pendingUserMessageId = entry.message.id;
      continue;
    }

    if (!pendingUserMessageId) {
      continue;
    }

    const summary = input.turnDiffSummaryByAssistantMessageId.get(entry.message.id);
    if (!summary) {
      continue;
    }

    const turnCount =
      summary.checkpointTurnCount ?? input.inferredCheckpointTurnCountByTurnId[summary.turnId];
    if (typeof turnCount === "number") {
      byUserMessageId.set(pendingUserMessageId, Math.max(0, turnCount - 1));
    }
    pendingUserMessageId = null;
  }

  return byUserMessageId;
}

/**
 * Rollback target for each turn whose edits can still be undone, keyed by turn.
 *
 * A turn is undoable only when its checkpoint is real and reachable: a missing
 * or errored summary has nothing to restore, and a `provider-diff:` ref is a
 * reported diff rather than a checkpoint we captured, so there is no commit to
 * roll back to. The stored count is the turn *before* this one — undoing means
 * returning the tree to how it looked when the turn started.
 */
export function deriveUndoTurnCountByTurnId(input: {
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  inferredCheckpointTurnCountByTurnId: Readonly<Partial<Record<TurnDiffSummary["turnId"], number>>>;
}): Map<TurnId, number> {
  const byTurnId = new Map<TurnId, number>();

  for (const summary of input.turnDiffSummaries) {
    if (summary.status === "missing" || summary.status === "error") {
      continue;
    }
    if (summary.checkpointRef === undefined || summary.checkpointRef.startsWith("provider-diff:")) {
      continue;
    }
    if (summary.files.length === 0) {
      continue;
    }
    const turnCount =
      summary.checkpointTurnCount ?? input.inferredCheckpointTurnCountByTurnId[summary.turnId];
    if (typeof turnCount === "number") {
      byTurnId.set(summary.turnId, Math.max(0, turnCount - 1));
    }
  }

  return byTurnId;
}

export function deriveMessagesTimelineRows(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  latestTurn?: TimelineLatestTurn | null;
  runningTurnId?: TurnId | null;
  turnFoldExpandedById?: Readonly<Record<string, boolean>>;
  workGroupExpandedById?: Readonly<Record<string, boolean>>;
  isWorking: boolean;
  activeTurnStartedAt: string | null;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  revertTurnCountByUserMessageId: ReadonlyMap<MessageId, number>;
  /** Per-turn rollback target for the changed-files card's Undo action. */
  undoTurnCountByTurnId?: ReadonlyMap<TurnId, number> | undefined;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const durationStartByMessageId = computeMessageDurationStart(
    input.timelineEntries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
  );
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(input.timelineEntries);
  const unsettledTurnId = deriveUnsettledTurnId(
    input.latestTurn ?? null,
    input.runningTurnId ?? null,
  );
  const foldsByAnchorEntryId = deriveTurnFolds({
    timelineEntries: input.timelineEntries,
    terminalAssistantMessageIds,
    latestTurn: input.latestTurn ?? null,
    unsettledTurnId,
    activeTurnStartedAt: input.activeTurnStartedAt,
    turnFoldExpandedById: input.turnFoldExpandedById ?? {},
  });
  const collapsedEntryIds = new Set<string>();
  for (const fold of foldsByAnchorEntryId.values()) {
    if (!fold.expanded) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedEntryIds.add(entryId);
      }
    }
  }
  let hasRunningFold = false;

  for (let index = 0; index < input.timelineEntries.length; index += 1) {
    const timelineEntry = input.timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    const turnFold = foldsByAnchorEntryId.get(timelineEntry.id);
    if (turnFold) {
      hasRunningFold ||= turnFold.status === "running";
      nextRows.push({
        kind: "turn-fold",
        id: turnFold.foldId,
        createdAt: turnFold.createdAt,
        turnId: turnFold.turnId,
        foldId: turnFold.foldId,
        status: turnFold.status,
        durationStart: turnFold.durationStart,
        label: turnFold.label,
        expanded: turnFold.expanded,
      });
    }

    if (collapsedEntryIds.has(timelineEntry.id)) {
      continue;
    }

    if (timelineEntry.kind === "work") {
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < input.timelineEntries.length) {
        const nextEntry = input.timelineEntries[cursor];
        if (
          !nextEntry ||
          nextEntry.kind !== "work" ||
          collapsedEntryIds.has(nextEntry.id) ||
          foldsByAnchorEntryId.has(nextEntry.id)
        ) {
          break;
        }
        groupedEntries.push(nextEntry.entry);
        cursor += 1;
      }
      if (groupedEntries.length < MIN_COLLAPSIBLE_WORK_LOG_ENTRIES) {
        nextRows.push({
          kind: "work",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          groupedEntries,
        });
      } else {
        const groupId = `work-group:${timelineEntry.id}`;
        const expanded = input.workGroupExpandedById?.[groupId] ?? false;
        // Keep agent navigation available, but fold the entire tool run into
        // one summary instead of leaving the latest tool beneath it.
        const hiddenEntries = groupedEntries.filter((entry) => entry.agentSpawn === undefined);
        if (hiddenEntries.length === 0) {
          nextRows.push({
            kind: "work",
            id: timelineEntry.id,
            createdAt: timelineEntry.createdAt,
            groupedEntries,
          });
          index = cursor - 1;
          continue;
        }
        const hiddenIds = new Set(hiddenEntries.map((entry) => entry.id));
        const visibleEntries = groupedEntries.filter(
          (entry) => entry.agentSpawn !== undefined || !hiddenIds.has(entry.id),
        );
        const renderedEntries = expanded ? groupedEntries : visibleEntries;

        // The recap leads the group: it reads as the heading of the run it
        // folds, and expanding it reveals the rows directly beneath. Every
        // field on the toggle describes the HIDDEN set — a visible spawn
        // row must not flip its wording.
        nextRows.push({
          kind: "work-toggle",
          id: `work-toggle:${timelineEntry.id}`,
          createdAt: timelineEntry.createdAt,
          groupId,
          hiddenCount: hiddenEntries.length,
          expanded,
          onlyToolEntries: hiddenEntries.every((entry) => entry.tone === "tool"),
          summary: summarizeToolCallGroup(hiddenEntries),
        });
        for (const workEntry of renderedEntries) {
          nextRows.push({
            kind: "work",
            id: workEntry.id,
            createdAt: workEntry.createdAt,
            groupedEntries: [workEntry],
          });
        }
      }
      index = cursor - 1;
      continue;
    }

    if (timelineEntry.kind === "proposed-plan") {
      nextRows.push({
        kind: "proposed-plan",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        proposedPlan: timelineEntry.proposedPlan,
      });
      continue;
    }

    if (timelineEntry.kind === "context-compaction") {
      nextRows.push({
        kind: "context-compaction",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        marker: timelineEntry.marker,
      });
      continue;
    }

    if (timelineEntry.kind === "context-handoff") {
      nextRows.push({
        kind: "context-handoff",
        id: timelineEntry.id,
        createdAt: timelineEntry.createdAt,
        marker: timelineEntry.marker,
      });
      continue;
    }

    // Resolved once: the summary supplies both the changed-files card and the
    // turn identity its Undo action rolls back to.
    const assistantTurnDiffSummary =
      timelineEntry.message.role === "assistant"
        ? input.turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
        : undefined;

    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart:
        durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt,
      showAssistantCopyButton:
        timelineEntry.message.role === "assistant" &&
        terminalAssistantMessageIds.has(timelineEntry.message.id),
      assistantTurnDiffSummary,
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? input.revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
      assistantUndoTurnCount: assistantTurnDiffSummary
        ? input.undoTurnCountByTurnId?.get(assistantTurnDiffSummary.turnId)
        : undefined,
    });
  }

  if (input.isWorking && !hasRunningFold) {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
    });
  }

  return nextRows;
}

export function computeStableMessagesTimelineRows(
  rows: MessagesTimelineRow[],
  previous: StableMessagesTimelineRowsState,
): StableMessagesTimelineRowsState {
  const next = new Map<string, MessagesTimelineRow>();
  let anyChanged = rows.length !== previous.byId.size;

  const result = rows.map((row, index) => {
    const prevRow = previous.byId.get(row.id);
    const nextRow = prevRow && isRowUnchanged(prevRow, row) ? prevRow : row;
    next.set(row.id, nextRow);
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true;
    }
    return nextRow;
  });

  return anyChanged ? { byId: next, result } : previous;
}

/** Shallow field comparison per row variant — avoids deep equality cost. */
function isRowUnchanged(a: MessagesTimelineRow, b: MessagesTimelineRow): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;

  switch (a.kind) {
    case "working":
      return a.createdAt === (b as typeof a).createdAt;

    case "turn-fold": {
      const bf = b as typeof a;
      return (
        a.createdAt === bf.createdAt &&
        a.foldId === bf.foldId &&
        a.status === bf.status &&
        a.durationStart === bf.durationStart &&
        a.label === bf.label &&
        a.expanded === bf.expanded
      );
    }

    case "work-toggle": {
      const bw = b as typeof a;
      return (
        a.createdAt === bw.createdAt &&
        a.groupId === bw.groupId &&
        a.hiddenCount === bw.hiddenCount &&
        a.expanded === bw.expanded &&
        a.onlyToolEntries === bw.onlyToolEntries &&
        // The label is derived from the folded run's composition, so it changes
        // exactly when the recap would render differently.
        a.summary?.label === bw.summary?.label
      );
    }

    case "proposed-plan":
      return a.proposedPlan === (b as typeof a).proposedPlan;

    case "work":
      return areWorkRowsUnchanged(a, b as typeof a);

    case "context-compaction":
      return a.marker === (b as typeof a).marker;

    case "context-handoff":
      return a.marker === (b as typeof a).marker;

    case "message": {
      const bm = b as typeof a;
      return (
        areMessagesUnchanged(a.message, bm.message) &&
        a.durationStart === bm.durationStart &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount &&
        a.assistantUndoTurnCount === bm.assistantUndoTurnCount
      );
    }
  }
}

function areWorkRowsUnchanged(
  previous: Extract<MessagesTimelineRow, { kind: "work" }>,
  next: Extract<MessagesTimelineRow, { kind: "work" }>,
): boolean {
  if (previous.createdAt !== next.createdAt) {
    return false;
  }
  if (previous.groupedEntries.length !== next.groupedEntries.length) {
    return false;
  }
  for (let index = 0; index < previous.groupedEntries.length; index += 1) {
    const previousEntry = previous.groupedEntries[index];
    const nextEntry = next.groupedEntries[index];
    if (!previousEntry || !nextEntry) {
      return false;
    }
    if (!areWorkLogEntriesUnchanged(previousEntry, nextEntry)) {
      return false;
    }
  }
  return true;
}

function areMessagesUnchanged(previous: ChatMessage, next: ChatMessage): boolean {
  return (
    previous === next ||
    (previous.id === next.id &&
      previous.role === next.role &&
      previous.text === next.text &&
      areChatAttachmentsUnchanged(previous.attachments, next.attachments) &&
      previous.turnId === next.turnId &&
      previous.createdAt === next.createdAt &&
      previous.completedAt === next.completedAt &&
      previous.streaming === next.streaming)
  );
}

function areWorkLogEntriesUnchanged(previous: WorkLogEntry, next: WorkLogEntry): boolean {
  return (
    previous === next ||
    (previous.id === next.id &&
      previous.createdAt === next.createdAt &&
      previous.label === next.label &&
      previous.detail === next.detail &&
      previous.command === next.command &&
      previous.rawCommand === next.rawCommand &&
      areStringArraysUnchanged(previous.changedFiles, next.changedFiles) &&
      areChangedFileStatsUnchanged(previous.changedFileStats, next.changedFileStats) &&
      previous.completed === next.completed &&
      previous.tone === next.tone &&
      previous.toolTitle === next.toolTitle &&
      previous.itemType === next.itemType &&
      previous.requestKind === next.requestKind &&
      previous.turnId === next.turnId &&
      previous.output === next.output &&
      previous.exitCode === next.exitCode &&
      previous.startedAt === next.startedAt &&
      previous.lastActivityAt === next.lastActivityAt)
  );
}

function areChangedFileStatsUnchanged(
  previous: WorkLogEntry["changedFileStats"],
  next: WorkLogEntry["changedFileStats"],
): boolean {
  if (previous === next) {
    return true;
  }
  const previousLength = previous?.length ?? 0;
  const nextLength = next?.length ?? 0;
  if (previousLength !== nextLength) {
    return false;
  }
  for (let index = 0; index < previousLength; index += 1) {
    const previousStat = previous?.[index];
    const nextStat = next?.[index];
    if (
      !previousStat ||
      !nextStat ||
      previousStat.path !== nextStat.path ||
      previousStat.kind !== nextStat.kind ||
      previousStat.additions !== nextStat.additions ||
      previousStat.deletions !== nextStat.deletions
    ) {
      return false;
    }
  }
  return true;
}

function areStringArraysUnchanged(
  previous: ReadonlyArray<string> | undefined,
  next: ReadonlyArray<string> | undefined,
): boolean {
  if (previous === next) {
    return true;
  }
  const previousLength = previous?.length ?? 0;
  const nextLength = next?.length ?? 0;
  if (previousLength !== nextLength) {
    return false;
  }
  for (let index = 0; index < previousLength; index += 1) {
    if (previous?.[index] !== next?.[index]) {
      return false;
    }
  }
  return true;
}

function areChatAttachmentsUnchanged(
  previous: ReadonlyArray<ChatAttachment> | undefined,
  next: ReadonlyArray<ChatAttachment> | undefined,
): boolean {
  if (previous === next) {
    return true;
  }
  const previousLength = previous?.length ?? 0;
  const nextLength = next?.length ?? 0;
  if (previousLength !== nextLength) {
    return false;
  }
  for (let index = 0; index < previousLength; index += 1) {
    const previousAttachment = previous?.[index];
    const nextAttachment = next?.[index];
    if (
      !previousAttachment ||
      !nextAttachment ||
      !areChatAttachmentUnchanged(previousAttachment, nextAttachment)
    ) {
      return false;
    }
  }
  return true;
}

function areChatAttachmentUnchanged(previous: ChatAttachment, next: ChatAttachment): boolean {
  if (previous === next) return true;
  if (
    previous.type !== next.type ||
    previous.id !== next.id ||
    previous.name !== next.name ||
    previous.mimeType !== next.mimeType ||
    previous.sizeBytes !== next.sizeBytes
  ) {
    return false;
  }
  if (!isChatImageAttachment(previous) || !isChatImageAttachment(next)) {
    return true;
  }
  return previous.previewUrl === next.previewUrl;
}
