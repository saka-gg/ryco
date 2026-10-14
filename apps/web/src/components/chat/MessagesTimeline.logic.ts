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
  isChatFileAttachment,
  isChatImageAttachment,
  type ChatAttachment,
  type ChatFileAttachment,
  type ChatMessage,
  type ProposedPlan,
  type TurnDiffSummary,
} from "../../types";
import {
  type EnvironmentId,
  type MessageId,
  type OrchestrationLatestTurn,
  type ProviderDriverKind,
  type ServerProviderSkill,
  type TurnId,
} from "@ryco/contracts";
import { type TimestampFormat } from "@ryco/contracts/settings";
import { htmlRenderMetadataEqual, type HtmlRenderMetadata } from "@ryco/shared/htmlRender";
import { type ExpandedImagePreview } from "./ExpandedImagePreview";
import {
  collectTurnHtmlRenders,
  deriveTerminalAssistantMessageIds,
  findTimelineMessageRowIndex,
  isBlankSettledReply,
  placeRepliesAfterHtmlRenders,
  type ForkOriginTimelineEntry,
  type TimelineRowMessages,
} from "@ryco/client-runtime/state/session";
import {
  deriveForkableReplyMessageIds,
  isMaterializableCheckpointSummary,
} from "@ryco/client-runtime/state/threads";
import { isHtmlRenderOnlyMessage, readHtmlRenderAttachment } from "./htmlRender.logic";
import type { ThreadMessageSearchOccurrence } from "./ThreadMessageSearch.logic";
import { summarizeToolCallGroup, type ToolCallGroupSummary } from "./toolCallGroup.logic";
import { classifyChapterStep } from "./workChapters.logic";

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

/** How far short of its end a pinned transcript may rest (sub-pixel offsets). */
const TIMELINE_END_PIN_EPSILON_PX = 1;

/**
 * Corrective passes one end pin may take. Growth that outlasts them is left to
 * the list's own live follow, so a transcript that never stops growing cannot
 * keep a pin looping.
 */
export const TIMELINE_END_PIN_MAX_PASSES = 4;

export interface TimelineEndPinTarget {
  /** Scrolls the list to its end; settles once the list considers the scroll done. */
  readonly scrollToEnd: (options: { readonly animated: boolean }) => Promise<void> | void;
  /** The live scroller's metrics, or null once the list is gone. */
  readonly readScrollMetrics: () => TimelineScrollMetrics | null;
}

/**
 * Scrolls the transcript to its end, then re-checks the live scroller once the
 * list settles and scrolls again until the end is really in view.
 *
 * LegendList can settle short of the end on web. Its scroll is clamped to the
 * content height the browser had laid out when it ran, and growth that lands
 * while the scroll is in flight (rows re-measuring, the composer clearance
 * changing) is not followed: the list drops its own `maintainScrollAtEnd`
 * re-pin while any scroll is in flight, and skips it entirely once the end is
 * further away than its threshold. Each pass reads the scroller afresh, so the
 * loop ends as soon as the end is in view, or once `shouldContinue` reports
 * that the pin no longer applies (the user navigated away, a newer pin took
 * over, the list was replaced).
 */
export async function pinTimelineToEnd(
  target: TimelineEndPinTarget,
  options: { readonly animated: boolean; readonly shouldContinue: () => boolean },
): Promise<void> {
  let animated = options.animated;
  for (let pass = 0; pass < TIMELINE_END_PIN_MAX_PASSES; pass += 1) {
    await target.scrollToEnd({ animated });
    if (!options.shouldContinue()) return;
    const metrics = target.readScrollMetrics();
    if (metrics === null || isTimelineRestingAtEnd(metrics)) return;
    // A correction jumps: the requested animation already played.
    animated = false;
  }
}

function isTimelineRestingAtEnd(metrics: TimelineScrollMetrics): boolean {
  const { scrollTop, scrollHeight, clientHeight } = metrics;
  if (
    !Number.isFinite(scrollTop) ||
    !Number.isFinite(scrollHeight) ||
    !Number.isFinite(clientHeight) ||
    clientHeight <= 0
  ) {
    return true;
  }
  return scrollHeight - clientHeight - scrollTop <= TIMELINE_END_PIN_EPSILON_PX;
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

/** The reply "Fork from here" was pressed on: the fork's inclusive boundary. */
export interface TimelineForkRequest {
  messageId: MessageId;
  turnId: TurnId;
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
  onOpenAgent: (agentId: string) => void;
  onOpenMessageActions: (request: TimelineMessageActionsRequest) => void;
  onInspectContextHandoff?: (
    marker: ContextHandoffTimelineEntry,
    trigger: HTMLButtonElement,
  ) => void;
  /**
   * Opens the fork dialog for an eligible reply. Absent where forking is not offered (the
   * frozen phone tier, drafts, nodes without the capability); the button is then not rendered.
   */
  onForkFromMessage?: (request: TimelineForkRequest, trigger: HTMLButtonElement) => void;
  /** Driver of the thread's provider, for the live turn header's mark. */
  providerDriverKind?: ProviderDriverKind | null;
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
    onOpenAgent: input.onOpenAgent,
    onOpenMessageActions: input.onOpenMessageActions,
    ...(input.onInspectContextHandoff
      ? { onInspectContextHandoff: input.onInspectContextHandoff }
      : {}),
    ...(input.onForkFromMessage ? { onForkFromMessage: input.onForkFromMessage } : {}),
    ...(input.providerDriverKind ? { providerDriverKind: input.providerDriverKind } : {}),
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

/** A page a turn published, listed again under the turn's reply. */
export interface TimelineTurnHtmlRender {
  readonly messageId: MessageId;
  readonly attachment: ChatFileAttachment;
  readonly htmlRender: HtmlRenderMetadata;
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
      /**
       * The pages the turn published, on its reply: the reply ends with a
       * card for each, and a page-only turn (no reply) has none.
       */
      turnHtmlRenders?: ReadonlyArray<TimelineTurnHtmlRender> | undefined;
      /**
       * "Fork from here" on the row that ends its turn: the turn's forkable reply (shared rule,
       * `deriveForkableReplyMessageIds`). That is this message, or the text reply before it
       * when this row is an attachment carrier the turn ended on. Only set where forking is
       * offered.
       */
      forkFrom?: TimelineForkRequest | undefined;
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
  | {
      /** A fork's divider between its inherited history and its own. */
      kind: "fork-origin";
      id: string;
      createdAt: string;
      marker: ForkOriginTimelineEntry;
    }
  | {
      /**
       * One commentary paragraph plus the steps (tool calls, reasoning) that
       * followed it inside an expanded turn. Finished chapters fold to a single
       * line; the live one shows its paragraph and a short step ticker.
       */
      kind: "chapter";
      id: string;
      createdAt: string;
      turnId: TurnId;
      /** The paragraph that opened the chapter; null when the agent started working first. */
      message: ChatMessage | null;
      entries: WorkLogEntry[];
      status: "active" | "done";
      /** User opened a finished chapter (or a search hit lives in it). */
      expanded: boolean;
      /** The live chapter shows every step instead of the ticker window. */
      stepsExpanded: boolean;
      isFirstInTurn: boolean;
      isLastInTurn: boolean;
      startedAt: string;
      /** Null while the chapter is live. */
      endedAt: string | null;
    }
  | {
      /**
       * One HTML render an agent published, shown in place of its carrier
       * message: never folded into the turn, never the turn's reply.
       */
      kind: "html-render";
      id: string;
      createdAt: string;
      messageId: MessageId;
      attachment: ChatFileAttachment;
      htmlRender: HtmlRenderMetadata;
      /** The turn's changed-files card, when the turn keyed it on this render's message. */
      assistantTurnDiffSummary?: TurnDiffSummary | undefined;
      assistantUndoTurnCount?: number | undefined;
      /**
       * "Fork from here" when the turn ended on its pages: on the last render of a page-only
       * turn (the carrier is the reply), or of a turn whose blank reply this render stands in for.
       */
      forkFrom?: TimelineForkRequest | undefined;
      /**
       * The turn's blank reply this render stands in for: it renders no row of its own, so a
       * link to it (a fork's origin) lands here. Set whether or not forking is offered.
       */
      standsInFor?: MessageId | undefined;
    }
  | { kind: "working"; id: string; createdAt: string | null };

/**
 * The size class of a timeline row for the virtualized list. Rows of one class
 * share a measured-size average, so tall assistant replies do not inflate the
 * estimate for compact work rows and markers (or the other way round) while
 * rows are still unmeasured.
 */
export function timelineRowItemType(row: MessagesTimelineRow): string {
  return row.kind === "message" ? `message:${row.message.role}` : row.kind;
}

export function chapterExpansionKey(chapterId: string): string {
  return chapterId;
}

export function chapterStepsExpansionKey(chapterId: string): string {
  return `${chapterId}:steps`;
}

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
    if (row?.kind === "chapter") {
      if (row.message) {
        finalAssistantText = row.message.text;
      }
      continue;
    }
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
  completedAt: string | null;
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
  liveSettledTurnIds: ReadonlySet<TurnId>;
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
      // A published page is part of the answer: a settled turn reads
      // [fold, page, reply], and a live one shows it between its chapters.
      if (entry.kind === "message" && isHtmlRenderOnlyMessage(entry.message)) {
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
    let effectiveEnd: string | null = null;
    if (!isRunning) {
      const authoritativeEnd =
        input.latestTurn?.turnId === turnId ? input.latestTurn.completedAt : null;
      const fallbackEnd =
        maxIsoTimestamp(
          group.terminalEntry ? timelineEntryEnd(group.terminalEntry) : null,
          timelineEntryEnd(lastEntry),
        ) ?? timelineEntryEnd(lastEntry);
      // A turn cannot end before its last visible output. Older projections
      // stamped completion at the first finished assistant message, which made
      // a long turn with an early progress update read "Worked for 4s".
      effectiveEnd = maxIsoTimestamp(authoritativeEnd, fallbackEnd) ?? fallbackEnd;
      const elapsedMs = computeElapsedMs(durationStart, effectiveEnd);
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
      // A turn the user watched finish keeps its chapter outline open (unless
      // they folded it while it ran); older turns and a fresh load start
      // folded down to their final answer.
      expanded:
        input.turnFoldExpandedById[foldId] ??
        (isRunning ||
          (input.liveSettledTurnIds.has(turnId) &&
            (input.turnFoldExpandedById[`turn-fold:running:${turnId}`] ?? true))),
      completedAt: effectiveEnd,
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
 * A turn is undoable only when its checkpoint is real and reachable — the
 * shared `isMaterializableCheckpointSummary` rule, which also decides whether a
 * fork's worktree can start from the turn's checkpoint. The stored count is the
 * turn *before* this one — undoing means returning the tree to how it looked
 * when the turn started.
 */
export function deriveUndoTurnCountByTurnId(input: {
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  inferredCheckpointTurnCountByTurnId: Readonly<Partial<Record<TurnDiffSummary["turnId"], number>>>;
}): Map<TurnId, number> {
  const byTurnId = new Map<TurnId, number>();

  for (const summary of input.turnDiffSummaries) {
    if (!isMaterializableCheckpointSummary(summary)) {
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

const EMPTY_TURN_ID_SET: ReadonlySet<TurnId> = new Set();
const EMPTY_STRING_SET: ReadonlySet<string> = new Set();

type ChapterRow = Extract<MessagesTimelineRow, { kind: "chapter" }>;

interface OpenChapter {
  fold: TurnFold;
  message: ChatMessage | null;
  entries: WorkLogEntry[];
  createdAt: string;
}

/** Thinking and runtime notices lead into the paragraph that follows them. */
function isPreludeEntry(entry: WorkLogEntry): boolean {
  const kind = classifyChapterStep(entry);
  return kind === "think" || kind === "note";
}

function entryStart(entry: WorkLogEntry): string {
  return entry.startedAt ?? entry.createdAt;
}

/**
 * Builds chapter rows while the main loop walks the timeline. Every assistant
 * paragraph inside an expanded fold opens a chapter; work entries join the
 * open one. Reasoning that immediately precedes a paragraph moves into that
 * paragraph's chapter — it is the thinking the paragraph reports on.
 */
class ChapterAccumulator {
  private open: OpenChapter | null = null;
  private readonly rowsByTurn = new Map<TurnId, ChapterRow[]>();

  constructor(
    private readonly options: {
      workGroupExpandedById: Readonly<Record<string, boolean>>;
      revealedMessageIds: ReadonlySet<string>;
      rows: MessagesTimelineRow[];
    },
  ) {}

  addEntry(fold: TurnFold, entry: WorkLogEntry) {
    if (!this.open || this.open.fold !== fold) {
      this.close();
      this.open = { fold, message: null, entries: [], createdAt: entry.createdAt };
    }
    this.open.entries.push(entry);
  }

  openWithMessage(fold: TurnFold, message: ChatMessage) {
    let carried: WorkLogEntry[] = [];
    if (this.open && this.open.fold === fold) {
      let cut = this.open.entries.length;
      while (cut > 0 && isPreludeEntry(this.open.entries[cut - 1]!)) {
        cut -= 1;
      }
      carried = this.open.entries.slice(cut);
      this.open.entries = this.open.entries.slice(0, cut);
      if (!this.open.message && this.open.entries.length === 0) {
        // Only thinking/notices so far: they belong to this paragraph, not a chapter of their own.
        this.open = null;
      }
    }
    this.close();
    this.open = {
      fold,
      message,
      entries: carried,
      createdAt: carried[0]?.createdAt ?? message.createdAt,
    };
  }

  close() {
    const open = this.open;
    if (!open) return;
    this.open = null;
    const anchorId = open.message?.id ?? open.entries[0]?.id;
    if (!anchorId) return;
    const id = `chapter:${anchorId}`;
    const firstEntry = open.entries[0];
    const starts = [
      ...(open.message ? [open.message.createdAt] : []),
      ...(firstEntry ? [entryStart(firstEntry)] : []),
    ].toSorted();
    const row: ChapterRow = {
      kind: "chapter",
      id,
      createdAt: open.createdAt,
      turnId: open.fold.turnId,
      message: open.message,
      entries: open.entries,
      status: "done",
      expanded:
        this.options.workGroupExpandedById[chapterExpansionKey(id)] ??
        (open.message !== null && this.options.revealedMessageIds.has(open.message.id)),
      stepsExpanded: this.options.workGroupExpandedById[chapterStepsExpansionKey(id)] ?? false,
      isFirstInTurn: false,
      isLastInTurn: false,
      startedAt: starts[0] ?? open.createdAt,
      endedAt: null,
    };
    this.options.rows.push(row);
    const turnRows = this.rowsByTurn.get(row.turnId);
    if (turnRows) turnRows.push(row);
    else this.rowsByTurn.set(row.turnId, [row]);
  }

  /** Chapter state needs its neighbours: position, live/done, and end time. */
  finalize(folds: ReadonlyMap<string, TurnFold>) {
    const foldByTurnId = new Map<TurnId, TurnFold>();
    for (const fold of folds.values()) foldByTurnId.set(fold.turnId, fold);
    for (const [turnId, turnRows] of this.rowsByTurn) {
      const fold = foldByTurnId.get(turnId);
      turnRows.forEach((row, index) => {
        const next = turnRows[index + 1];
        const isLast = next === undefined;
        row.isFirstInTurn = index === 0;
        row.isLastInTurn = isLast;
        if (isLast && fold?.status === "running") {
          row.status = "active";
          row.endedAt = null;
          return;
        }
        row.endedAt = next ? next.startedAt : (fold?.completedAt ?? chapterLastActivity(row));
      });
    }
  }
}

function chapterLastActivity(row: ChapterRow): string {
  let latest = row.message?.completedAt ?? row.message?.createdAt ?? row.startedAt;
  for (const entry of row.entries) {
    const at = entry.lastActivityAt ?? entry.createdAt;
    if (at > latest) latest = at;
  }
  return latest;
}

/**
 * Each turn's forkable reply (shared `deriveForkableReplyMessageIds`: the reply the turn ended
 * on, settled), by turn, so the row that ends the turn can offer it whatever kind of row it is.
 */
function deriveForkReplyByTurn(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  latestTurn: TimelineLatestTurn | null,
  unsettledTurnId: TurnId | null,
): ReadonlyMap<TurnId, MessageId> {
  const messages = timelineEntries.flatMap((entry) =>
    entry.kind === "message" ? [entry.message] : [],
  );
  const forkable = deriveForkableReplyMessageIds({
    messages,
    latestTurn,
    // A turn this view still treats as running is the session's active turn.
    session: { activeTurnId: unsettledTurnId ?? undefined },
  });
  const byTurn = new Map<TurnId, MessageId>();
  if (forkable.size === 0) return byTurn;
  for (const message of messages) {
    if (message.turnId && forkable.has(message.id)) byTurn.set(message.turnId, message.id);
  }
  return byTurn;
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
  /** Turns seen running in this view; they stay expanded once they settle. */
  liveSettledTurnIds?: ReadonlySet<TurnId> | undefined;
  /** Messages a search or deep link points at — their chapter renders open. */
  revealedMessageIds?: ReadonlySet<string> | undefined;
  /** Offers "Fork from here" (`forkFrom`) on the row that ends each forkable turn. */
  offerFork?: boolean | undefined;
  /** Renders a fork's origin divider; the frozen phone tier shows nothing new. */
  showForkOrigin?: boolean | undefined;
}): MessagesTimelineRow[] {
  const nextRows: MessagesTimelineRow[] = [];
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(input.timelineEntries);
  const unsettledTurnId = deriveUnsettledTurnId(
    input.latestTurn ?? null,
    input.runningTurnId ?? null,
  );
  const forkReplyByTurn = input.offerFork
    ? deriveForkReplyByTurn(input.timelineEntries, input.latestTurn ?? null, unsettledTurnId)
    : null;
  const forkFromTurn = (turnId: TurnId | null | undefined): TimelineForkRequest | undefined => {
    const messageId = turnId ? forkReplyByTurn?.get(turnId) : undefined;
    return turnId && messageId ? { messageId, turnId } : undefined;
  };
  const timelineEntries = placeRepliesAfterHtmlRenders(
    input.timelineEntries,
    terminalAssistantMessageIds,
    { runningTurnId: unsettledTurnId },
  );
  // A render's completion is not a response boundary: the reply after it still
  // counts from the turn's start.
  const durationStartByMessageId = computeMessageDurationStart(
    timelineEntries.flatMap((entry) =>
      entry.kind === "message" && !isHtmlRenderOnlyMessage(entry.message) ? [entry.message] : [],
    ),
  );
  // The last render row of each turn, which takes over a blank reply's place.
  const lastRenderRowIndexByTurn = new Map<TurnId, number>();
  // Each turn's pages, which its reply lists again as cards.
  const htmlRendersByTurn = collectTurnHtmlRenders(timelineEntries);
  const foldsByAnchorEntryId = deriveTurnFolds({
    timelineEntries,
    terminalAssistantMessageIds,
    latestTurn: input.latestTurn ?? null,
    unsettledTurnId,
    activeTurnStartedAt: input.activeTurnStartedAt,
    turnFoldExpandedById: input.turnFoldExpandedById ?? {},
    liveSettledTurnIds: input.liveSettledTurnIds ?? EMPTY_TURN_ID_SET,
  });
  const collapsedEntryIds = new Set<string>();
  // Members of an expanded fold render as chapters instead of loose rows.
  const chapterFoldByEntryId = new Map<string, TurnFold>();
  for (const fold of foldsByAnchorEntryId.values()) {
    for (const entryId of fold.hiddenEntryIds) {
      if (fold.expanded) {
        chapterFoldByEntryId.set(entryId, fold);
      } else {
        collapsedEntryIds.add(entryId);
      }
    }
  }
  let hasRunningFold = false;
  const chapters = new ChapterAccumulator({
    workGroupExpandedById: input.workGroupExpandedById ?? {},
    revealedMessageIds: input.revealedMessageIds ?? EMPTY_STRING_SET,
    rows: nextRows,
  });

  for (let index = 0; index < timelineEntries.length; index += 1) {
    const timelineEntry = timelineEntries[index];
    if (!timelineEntry) {
      continue;
    }

    const turnFold = foldsByAnchorEntryId.get(timelineEntry.id);
    if (turnFold) {
      chapters.close();
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

    const chapterFold = chapterFoldByEntryId.get(timelineEntry.id);
    if (chapterFold) {
      if (timelineEntry.kind === "work") {
        // Approvals are answered from the composer's pending card; inside a
        // chapter they would read as phantom running commands.
        if (timelineEntry.entry.approvalLifecycle !== true) {
          chapters.addEntry(chapterFold, timelineEntry.entry);
        }
        continue;
      }
      if (timelineEntry.kind === "message" && timelineEntry.message.role === "assistant") {
        chapters.openWithMessage(chapterFold, timelineEntry.message);
        continue;
      }
    }
    chapters.close();

    if (timelineEntry.kind === "work") {
      const groupedEntries = [timelineEntry.entry];
      let cursor = index + 1;
      while (cursor < timelineEntries.length) {
        const nextEntry = timelineEntries[cursor];
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
      mergeDirectSpawnEntries(groupedEntries);
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

    if (timelineEntry.kind === "fork-origin") {
      if (input.showForkOrigin) {
        nextRows.push({
          kind: "fork-origin",
          id: timelineEntry.id,
          createdAt: timelineEntry.createdAt,
          marker: timelineEntry.marker,
        });
      }
      continue;
    }

    // Resolved once: the summary supplies both the changed-files card and the
    // turn identity its Undo action rolls back to.
    const assistantTurnDiffSummary =
      timelineEntry.message.role === "assistant"
        ? input.turnDiffSummaryByAssistantMessageId.get(timelineEntry.message.id)
        : undefined;
    const assistantUndoTurnCount = assistantTurnDiffSummary
      ? input.undoTurnCountByTurnId?.get(assistantTurnDiffSummary.turnId)
      : undefined;

    if (isHtmlRenderOnlyMessage(timelineEntry.message)) {
      const { message } = timelineEntry;
      const renders = (message.attachments ?? []).flatMap((attachment) => {
        const render = readHtmlRenderAttachment(attachment);
        return render === undefined ? [] : [render];
      });
      // A page-only turn ends on its latest carrier, which is then its reply.
      const pageForkFrom = forkFromTurn(message.turnId);
      const forkFrom = pageForkFrom?.messageId === message.id ? pageForkFrom : undefined;
      renders.forEach(({ attachment, htmlRender }, renderIndex) => {
        const last = renderIndex === renders.length - 1;
        if (last && message.turnId) lastRenderRowIndexByTurn.set(message.turnId, nextRows.length);
        nextRows.push({
          kind: "html-render",
          id: `html-render:${message.id}:${attachment.id}`,
          createdAt: timelineEntry.createdAt,
          messageId: message.id,
          attachment,
          htmlRender,
          // A turn whose last message is a render keys its changed files on it.
          assistantTurnDiffSummary: last ? assistantTurnDiffSummary : undefined,
          assistantUndoTurnCount: last ? assistantUndoTurnCount : undefined,
          ...(last && forkFrom ? { forkFrom } : {}),
        });
      });
      continue;
    }

    const renderRowIndex = timelineEntry.message.turnId
      ? lastRenderRowIndexByTurn.get(timelineEntry.message.turnId)
      : undefined;
    if (
      renderRowIndex !== undefined &&
      terminalAssistantMessageIds.has(timelineEntry.message.id) &&
      isBlankSettledReply(timelineEntry.message)
    ) {
      // The turn answered with its page alone: no "(empty response)" under it.
      const renderRow = nextRows[renderRowIndex];
      // The page stands in for the blank reply, so it offers the fork from that reply.
      const blankForkFrom = forkFromTurn(timelineEntry.message.turnId);
      const forkFrom =
        blankForkFrom?.messageId === timelineEntry.message.id ? blankForkFrom : undefined;
      if (renderRow?.kind === "html-render") {
        const takesSummary = renderRow.assistantTurnDiffSummary === undefined;
        nextRows[renderRowIndex] = {
          ...renderRow,
          ...(takesSummary ? { assistantTurnDiffSummary, assistantUndoTurnCount } : {}),
          ...(forkFrom ? { forkFrom } : {}),
          standsInFor: timelineEntry.message.id,
        };
      }
      continue;
    }

    // The changed-files card closes the turn: a reply below the turn's render
    // takes it over when the server keyed it on the render's message.
    let replyTurnDiffSummary = assistantTurnDiffSummary;
    let replyUndoTurnCount = assistantUndoTurnCount;
    const renderRow = renderRowIndex === undefined ? undefined : nextRows[renderRowIndex];
    if (
      renderRowIndex !== undefined &&
      renderRow?.kind === "html-render" &&
      renderRow.assistantTurnDiffSummary !== undefined &&
      replyTurnDiffSummary === undefined &&
      terminalAssistantMessageIds.has(timelineEntry.message.id)
    ) {
      replyTurnDiffSummary = renderRow.assistantTurnDiffSummary;
      replyUndoTurnCount = renderRow.assistantUndoTurnCount;
      nextRows[renderRowIndex] = {
        ...renderRow,
        assistantTurnDiffSummary: undefined,
        assistantUndoTurnCount: undefined,
      };
    }

    const isReply =
      timelineEntry.message.role === "assistant" &&
      terminalAssistantMessageIds.has(timelineEntry.message.id);
    const turnHtmlRenders =
      isReply && timelineEntry.message.turnId
        ? htmlRendersByTurn.get(timelineEntry.message.turnId)
        : undefined;
    // The turn's last row offers its fork, also when that row is a file the
    // turn published after its text reply (the fork still ends with the turn).
    const replyForkFrom = isReply ? forkFromTurn(timelineEntry.message.turnId) : undefined;
    nextRows.push({
      kind: "message",
      id: timelineEntry.id,
      createdAt: timelineEntry.createdAt,
      message: timelineEntry.message,
      durationStart:
        durationStartByMessageId.get(timelineEntry.message.id) ?? timelineEntry.message.createdAt,
      showAssistantCopyButton: isReply,
      assistantTurnDiffSummary: replyTurnDiffSummary,
      revertTurnCount:
        timelineEntry.message.role === "user"
          ? input.revertTurnCountByUserMessageId.get(timelineEntry.message.id)
          : undefined,
      assistantUndoTurnCount: replyUndoTurnCount,
      turnHtmlRenders: turnHtmlRenders?.map((render) => ({
        // The carrier's own id, widened by the shared helper.
        messageId: render.messageId as MessageId,
        attachment: render.attachment,
        htmlRender: render.htmlRender,
      })),
      ...(replyForkFrom ? { forkFrom: replyForkFrom } : {}),
    });
  }

  chapters.close();
  chapters.finalize(foldsByAnchorEntryId);

  if (input.isWorking && !hasRunningFold) {
    nextRows.push({
      kind: "working",
      id: "working-indicator-row",
      createdAt: input.activeTurnStartedAt,
    });
  }

  return nextRows;
}

/**
 * The messages a row shows, for scrolling to and highlighting one (a fork's origin, a search hit,
 * a deep link). A render row also stands in for the blank reply its turn ended on.
 */
export function messagesOfTimelineRow(row: MessagesTimelineRow): TimelineRowMessages {
  switch (row.kind) {
    case "message":
      return { messageId: row.message.id };
    case "chapter":
      return { messageId: row.message?.id ?? null };
    case "html-render":
      return { messageId: row.messageId, standsInFor: row.standsInFor ?? null };
    default:
      return { messageId: null };
  }
}

/** The row a link to `messageId` lands on (the shared rule), or -1 while it is not loaded. */
export function findMessagesTimelineRowIndex(
  rows: ReadonlyArray<MessagesTimelineRow>,
  messageId: MessageId,
): number {
  return findTimelineMessageRowIndex(rows, messageId, messagesOfTimelineRow);
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

    case "chapter": {
      const bc = b as typeof a;
      if (
        a.createdAt !== bc.createdAt ||
        a.status !== bc.status ||
        a.expanded !== bc.expanded ||
        a.stepsExpanded !== bc.stepsExpanded ||
        a.isFirstInTurn !== bc.isFirstInTurn ||
        a.isLastInTurn !== bc.isLastInTurn ||
        a.startedAt !== bc.startedAt ||
        a.endedAt !== bc.endedAt ||
        a.entries.length !== bc.entries.length
      ) {
        return false;
      }
      if (
        a.message !== bc.message &&
        (!a.message || !bc.message || !areMessagesUnchanged(a.message, bc.message))
      ) {
        return false;
      }
      return a.entries.every((entry, index) =>
        areWorkLogEntriesUnchanged(entry, bc.entries[index]!),
      );
    }

    case "context-handoff":
      return a.marker === (b as typeof a).marker;

    case "fork-origin":
      // The shared decoder caches one marker per activity record.
      return a.marker === (b as typeof a).marker;

    case "html-render": {
      // Rows rebuild on every thread update; an equal page must keep its
      // mounted frame, or the page would reload.
      const bh = b as typeof a;
      return (
        a.createdAt === bh.createdAt &&
        a.messageId === bh.messageId &&
        areChatAttachmentUnchanged(a.attachment, bh.attachment) &&
        htmlRenderMetadataEqual(a.htmlRender, bh.htmlRender) &&
        a.assistantTurnDiffSummary === bh.assistantTurnDiffSummary &&
        a.assistantUndoTurnCount === bh.assistantUndoTurnCount &&
        a.forkFrom?.messageId === bh.forkFrom?.messageId &&
        a.standsInFor === bh.standsInFor
      );
    }

    case "message": {
      const bm = b as typeof a;
      return (
        areMessagesUnchanged(a.message, bm.message) &&
        a.durationStart === bm.durationStart &&
        a.showAssistantCopyButton === bm.showAssistantCopyButton &&
        a.assistantTurnDiffSummary === bm.assistantTurnDiffSummary &&
        a.revertTurnCount === bm.revertTurnCount &&
        a.assistantUndoTurnCount === bm.assistantUndoTurnCount &&
        a.forkFrom?.messageId === bm.forkFrom?.messageId &&
        areTurnHtmlRendersUnchanged(a.turnHtmlRenders, bm.turnHtmlRenders)
      );
    }
  }
}

function areTurnHtmlRendersUnchanged(
  previous: ReadonlyArray<TimelineTurnHtmlRender> | undefined,
  next: ReadonlyArray<TimelineTurnHtmlRender> | undefined,
): boolean {
  if (previous === next) return true;
  if (previous === undefined || next === undefined || previous.length !== next.length) {
    return false;
  }
  return previous.every((render, index) => {
    const other = next[index]!;
    return (
      render.messageId === other.messageId &&
      areChatAttachmentUnchanged(render.attachment, other.attachment) &&
      htmlRenderMetadataEqual(render.htmlRender, other.htmlRender)
    );
  });
}

/**
 * At most one direct-spawn CTA per work block. Agents spawned across turns
 * (or reported without a turn) land as separate batches; side by side they
 * read as a wall of "Kicked off 1 subagent". The first row anchors the merged
 * batch; the Agents panel and composer chip carry the per-agent detail.
 * Workflow CTAs stay separate: each names its own run.
 */
function mergeDirectSpawnEntries(entries: WorkLogEntry[]): void {
  let anchorIndex = -1;
  let agentTaskIds: string[] | null = null;
  let writeIndex = 0;
  for (const entry of entries) {
    if (entry.agentSpawn && entry.agentSpawn.workflowId === null) {
      if (anchorIndex === -1) {
        anchorIndex = writeIndex;
      } else {
        agentTaskIds ??= [...entries[anchorIndex]!.agentSpawn!.agentTaskIds];
        for (const taskId of entry.agentSpawn.agentTaskIds) {
          if (!agentTaskIds.includes(taskId)) agentTaskIds.push(taskId);
        }
        continue;
      }
    }
    entries[writeIndex] = entry;
    writeIndex += 1;
  }
  entries.length = writeIndex;
  if (agentTaskIds) {
    const anchor = entries[anchorIndex]!;
    entries[anchorIndex] = { ...anchor, agentSpawn: { workflowId: null, agentTaskIds } };
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
      previous.outputPreviewActivityId === next.outputPreviewActivityId &&
      previous.exitCode === next.exitCode &&
      previous.startedAt === next.startedAt &&
      previous.lastActivityAt === next.lastActivityAt &&
      areAgentSpawnsUnchanged(previous.agentSpawn, next.agentSpawn))
  );
}

function areAgentSpawnsUnchanged(
  previous: WorkLogEntry["agentSpawn"],
  next: WorkLogEntry["agentSpawn"],
): boolean {
  return (
    previous === next ||
    (previous !== undefined &&
      next !== undefined &&
      previous.workflowId === next.workflowId &&
      areStringArraysUnchanged(previous.agentTaskIds, next.agentTaskIds))
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
  if (isChatFileAttachment(previous) && isChatFileAttachment(next)) {
    // Whether (and at what size) a file shows as an inline render.
    const previousRender = readHtmlRenderAttachment(previous)?.htmlRender;
    const nextRender = readHtmlRenderAttachment(next)?.htmlRender;
    return previousRender === undefined || nextRender === undefined
      ? previousRender === nextRender
      : htmlRenderMetadataEqual(previousRender, nextRender);
  }
  if (!isChatImageAttachment(previous) || !isChatImageAttachment(next)) {
    return true;
  }
  return previous.previewUrl === next.previewUrl;
}
