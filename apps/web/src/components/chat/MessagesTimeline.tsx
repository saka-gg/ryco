import { parseScopedThreadKey } from "@ryco/client-runtime/scoped";
import {
  type EnvironmentId,
  type MessageId,
  type ServerProviderSkill,
  type TurnId,
} from "@ryco/contracts";
import {
  createContext,
  memo,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  deriveTimelineEntries,
  formatElapsed,
  type ContextHandoffTimelineEntry,
} from "../../session-logic";
import {
  emptyAgentPanelModel,
  formatSubagentTokenCount,
  type AgentPanelModel,
} from "../../threadWorkspaceViewModel";
import { glassSurfaceClassName } from "../mobile/GlassSurface";
import { type TurnDiffSummary } from "../../types";
import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  EyeIcon,
  FileDiffIcon,
  GitBranchIcon,
  GlobeIcon,
  HammerIcon,
  type LucideIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { MessageAttachments } from "./MessageAttachments";
import { type ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { VscodeEntryIcon } from "./VscodeEntryIcon";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  buildTimelineStableState,
  buildTimelineStreamingState,
  computeStableMessagesTimelineRows,
  deriveTimelineMinimapItems,
  isErroredWorkEntry,
  isTimelineScrolledToEnd,
  deriveMessagesTimelineRows,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  resolveTimelineMinimapHasPersistentGutter,
  resolveTimelineMinimapHeightStyle,
  resolveTimelineMinimapHitStripWidth,
  resolveTimelineMinimapIndexFromPointer,
  resolveTimelineMinimapInteractiveWidth,
  resolveTimelineMinimapTopPercent,
  type StableMessagesTimelineRowsState,
  type MessagesTimelineRow,
  type TimelineMinimapItem,
  type TimelineMessageActionsRequest,
  type TimelineStableState,
  type TimelineStreamingState,
  type TimelineLatestTurn,
  TIMELINE_MINIMAP_MIN_ITEMS,
} from "./MessagesTimeline.logic";
import { MessageActionsSheet } from "./MessageActionsSheet";
import { ContextHandoffMarkerRow } from "./ContextHandoffMarkerRow";
import { useLongPress } from "~/hooks/useLongPress";
import { usePresentationTier } from "~/hooks/usePresentationTier";
import type { ThreadMessageSearchOccurrence } from "./ThreadMessageSearch.logic";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import { useUiStateStore } from "~/uiStateStore";
import { type TimestampFormat } from "@ryco/contracts/settings";
import { formatTimestamp } from "../../timestampFormat";
import { usePerfMark } from "../../perf/tabSwitchInstrumentation";
import { visibleSecondTicker } from "../../lib/perf/ticker";

import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";
import { SkillInlineText, type SkillInlineTextSearchHighlight } from "./SkillInlineText";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { DISCLOSURE_CLEANUP_BUFFER_MS, DISCLOSURE_TRANSITION_MS } from "../../lib/disclosureMotion";
import {
  basenameOfPath,
  deriveReadableCommandDisplay,
  normalizeToolTextForComparison,
  resolveCommandVisualKind,
} from "../../lib/toolCallLabel";
import {
  formatWorkEntryElapsed,
  formatWorkEntryStatusLabel,
  resolveWorkEntryStatus,
  workEntryActivityMeta,
} from "./workEntryActivity";

// ---------------------------------------------------------------------------
// Context — shared state consumed by row components via useContext. Split into
// two contexts so streaming transitions (activeTurnInProgress / isWorking / …)
// do not invalidate the stable context value (theme/cwd/skills/timestampFormat/
// callbacks). Rows that only read stable state skip re-rendering during
// streaming. Propagates through LegendList's memo boundaries. `nowIso` is
// intentionally excluded — self-ticking components (WorkingTimer, LiveElapsed)
// handle it.
// ---------------------------------------------------------------------------

const TimelineStreamingCtx = createContext<TimelineStreamingState>(null!);
const TimelineStableCtx = createContext<TimelineStableState>(null!);
const NOOP_CLOSE_DIFF = () => {};
/* Top clearance mirrors the footer: when the desktop header overlays the
   transcript, the chat shell publishes `--chat-header-clearance` and the
   first row always clears the floating bar. */
const TIMELINE_LIST_HEADER = (
  <div className="h-[var(--chat-header-clearance,0.75rem)] sm:h-[var(--chat-header-clearance,1rem)]" />
);
/* When the desktop composer overlays the transcript, the chat column
   publishes `--chat-composer-clearance` (bar height + gap) and this footer
   becomes the internal scroll clearance — content scrolls beneath the glass
   bar but the last line can always clear it. Unset (phone tier, new-thread
   hero), it falls back to the original static spacer. */
const TIMELINE_LIST_FOOTER = (
  <div className="h-[var(--chat-composer-clearance,0.75rem)] sm:h-[var(--chat-composer-clearance,1rem)]" />
);
const EMPTY_TIMELINE_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];
const EMPTY_AGENT_PANEL_MODEL = emptyAgentPanelModel();
const NOOP_OPEN_AGENTS = () => {};
const EMPTY_THREAD_MESSAGE_SEARCH_OCCURRENCES_BY_MESSAGE_ID: ReadonlyMap<
  MessageId,
  ReadonlyArray<ThreadMessageSearchOccurrence>
> = new Map();
const EMPTY_EXPANSION_OVERRIDES: Readonly<Record<string, boolean>> = {};
const MESSAGE_SEARCH_HIGHLIGHT_DURATION_MS = 1_800;
const MESSAGE_ACTION_BUTTON_CLASS_NAME =
  "size-6 min-w-6 rounded-md border-0 bg-transparent px-0 text-muted-foreground/45 shadow-none transition-[background-color,color,box-shadow] before:hidden hover:bg-foreground/8 hover:text-foreground/75 hover:shadow-sm/5 focus-visible:ring-1 focus-visible:ring-ring/60 disabled:hover:bg-transparent disabled:hover:text-muted-foreground/35";

// ---------------------------------------------------------------------------
// Props (public API)
// ---------------------------------------------------------------------------

interface MessagesTimelineProps {
  agentPanelModel?: AgentPanelModel;
  onOpenAgents?: () => void;
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnId?: TurnId | null;
  latestTurn?: TimelineLatestTurn | null;
  activeTurnStartedAt: string | null;
  listRef: React.RefObject<LegendListRef | null>;
  targetMessageId?: MessageId | null;
  targetMessageRequestId?: number;
  targetMessageRowHighlight?: boolean;
  threadMessageSearchQuery?: string;
  threadMessageSearchOccurrencesByMessageId?: ReadonlyMap<
    MessageId,
    ReadonlyArray<ThreadMessageSearchOccurrence>
  >;
  activeThreadMessageSearchOccurrence?: ThreadMessageSearchOccurrence | null;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  openDiffTurnId?: TurnId | null;
  routeThreadKey: string;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onCloseDiff?: () => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  undoTurnCountByTurnId?: ReadonlyMap<TurnId, number> | undefined;
  onRevertUserMessage: (messageId: MessageId) => void;
  onUndoTurn: (turnCount: number) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  activeThreadEnvironmentId: EnvironmentId;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  /** Enables LegendList's automatic pinning only while the user follows live output. */
  liveFollowEnabled?: boolean;
  onIsAtEndChange: (isAtEnd: boolean) => void;
  onManualNavigation?: () => void;
  onUserReachedEnd?: () => void;
  canLoadOlder?: boolean;
  isLoadingOlder?: boolean;
  loadOlderError?: string | null;
  onLoadOlder?: () => void;
  onInspectContextHandoff?: (
    marker: ContextHandoffTimelineEntry,
    trigger: HTMLButtonElement,
  ) => void;
}

// ---------------------------------------------------------------------------
// MessagesTimeline — list owner
// ---------------------------------------------------------------------------

export const MessagesTimeline = memo(function MessagesTimeline({
  agentPanelModel = EMPTY_AGENT_PANEL_MODEL,
  onOpenAgents = NOOP_OPEN_AGENTS,
  isWorking,
  activeTurnInProgress,
  activeTurnId,
  latestTurn = null,
  activeTurnStartedAt,
  listRef,
  targetMessageId = null,
  targetMessageRequestId = 0,
  targetMessageRowHighlight = true,
  threadMessageSearchQuery = "",
  threadMessageSearchOccurrencesByMessageId = EMPTY_THREAD_MESSAGE_SEARCH_OCCURRENCES_BY_MESSAGE_ID,
  activeThreadMessageSearchOccurrence = null,
  timelineEntries,
  turnDiffSummaryByAssistantMessageId,
  openDiffTurnId = null,
  routeThreadKey,
  onOpenTurnDiff,
  onCloseDiff,
  revertTurnCountByUserMessageId,
  undoTurnCountByTurnId,
  onRevertUserMessage,
  onUndoTurn,
  isRevertingCheckpoint,
  onImageExpand,
  activeThreadEnvironmentId,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  skills = EMPTY_TIMELINE_SKILLS,
  liveFollowEnabled = true,
  onIsAtEndChange,
  onManualNavigation,
  onUserReachedEnd,
  canLoadOlder = false,
  isLoadingOlder = false,
  loadOlderError = null,
  onLoadOlder,
  onInspectContextHandoff,
}: MessagesTimelineProps) {
  usePerfMark("MessagesTimeline");
  const turnFoldExpandedById = useUiStateStore(
    (store) => store.threadTurnFoldExpandedById[routeThreadKey] ?? EMPTY_EXPANSION_OVERRIDES,
  );
  const workGroupExpandedById = useUiStateStore(
    (store) => store.threadWorkGroupExpandedById[routeThreadKey] ?? EMPTY_EXPANSION_OVERRIDES,
  );
  const revertTurnCountRef = useRef(revertTurnCountByUserMessageId);
  revertTurnCountRef.current = revertTurnCountByUserMessageId;
  const undoTurnCountRef = useRef(undoTurnCountByTurnId);
  undoTurnCountRef.current = undoTurnCountByTurnId;
  const rawRows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        latestTurn,
        runningTurnId: isWorking || activeTurnInProgress ? (activeTurnId ?? null) : null,
        turnFoldExpandedById,
        workGroupExpandedById,
        isWorking,
        activeTurnStartedAt,
        turnDiffSummaryByAssistantMessageId,
        revertTurnCountByUserMessageId: revertTurnCountRef.current,
        undoTurnCountByTurnId: undoTurnCountRef.current,
      }),
    [
      timelineEntries,
      latestTurn,
      activeTurnInProgress,
      activeTurnId,
      turnFoldExpandedById,
      workGroupExpandedById,
      isWorking,
      activeTurnStartedAt,
      turnDiffSummaryByAssistantMessageId,
    ],
  );
  const rows = useStableRows(rawRows);
  const minimapItems = useMemo(() => deriveTimelineMinimapItems(rows), [rows]);
  const [minimapStripMap] = useState(() => new Map<string, HTMLSpanElement>());
  const [timelineViewportElement, setTimelineViewportElement] = useState<HTMLDivElement | null>(
    null,
  );
  const [minimapHasPersistentGutter, setMinimapHasPersistentGutter] = useState(false);
  const [minimapHitStripWidth, setMinimapHitStripWidth] = useState(0);
  const [highlightedMessageId, setHighlightedMessageId] = useState<MessageId | null>(null);
  // Long-press target for the phone message action sheet.
  const [messageActionsRequest, setMessageActionsRequest] =
    useState<TimelineMessageActionsRequest | null>(null);
  const manualScrollIntentRef = useRef(false);
  const manualScrollIntentTimerRef = useRef<number | null>(null);
  const markManualScrollIntent = useCallback(() => {
    manualScrollIntentRef.current = true;
    if (manualScrollIntentTimerRef.current !== null) {
      window.clearTimeout(manualScrollIntentTimerRef.current);
    }
    manualScrollIntentTimerRef.current = window.setTimeout(() => {
      manualScrollIntentRef.current = false;
      manualScrollIntentTimerRef.current = null;
    }, 800);
  }, []);
  const onOpenMessageActions = useCallback((request: TimelineMessageActionsRequest) => {
    setMessageActionsRequest(request);
  }, []);

  // Measure the live scroller instead of LegendList's cached `isAtEnd`: that
  // flag is only refreshed inside the list's own layout/scroll passes, so a
  // transcript short enough never to scroll keeps whatever value it was
  // initialised with and the scroll-to-bottom pill sticks around forever.
  const evaluateIsAtEnd = useCallback((): boolean | null => {
    const scrollNode = listRef.current?.getScrollableNode?.();
    if (!(scrollNode instanceof HTMLElement)) {
      return null;
    }
    const isAtEnd = isTimelineScrolledToEnd(scrollNode);
    onIsAtEndChange(isAtEnd);
    return isAtEnd;
  }, [listRef, onIsAtEndChange]);

  const handleScroll = useCallback(() => {
    const isAtEnd = evaluateIsAtEnd();
    const scrollNode = listRef.current?.getScrollableNode?.();
    if (
      scrollNode instanceof HTMLElement &&
      scrollNode.scrollTop <= 320 &&
      canLoadOlder &&
      !isLoadingOlder
    ) {
      onLoadOlder?.();
    }
    if (isAtEnd === true && manualScrollIntentRef.current) {
      manualScrollIntentRef.current = false;
      if (manualScrollIntentTimerRef.current !== null) {
        window.clearTimeout(manualScrollIntentTimerRef.current);
        manualScrollIntentTimerRef.current = null;
      }
      onUserReachedEnd?.();
    }
    const state = listRef.current?.getState?.();
    if (!state || minimapItems.length === 0) {
      return;
    }

    const scrollTop = state.scroll ?? 0;
    const scrollBottom = scrollTop + (state.scrollLength ?? 0);

    for (const item of minimapItems) {
      const strip = minimapStripMap.get(item.id);
      if (!strip) {
        continue;
      }

      const rowTop = resolveTimelineRowTop(state, item.rowIndex);
      const rowHeight = resolveTimelineRowHeight(state, item.rowIndex);
      const inView =
        rowTop !== null &&
        rowTop < scrollBottom &&
        rowTop + Math.max(1, rowHeight ?? 1) > scrollTop;

      strip.dataset.inView = inView ? "true" : "false";
    }
  }, [
    canLoadOlder,
    evaluateIsAtEnd,
    isLoadingOlder,
    listRef,
    minimapItems,
    minimapStripMap,
    onLoadOlder,
    onUserReachedEnd,
  ]);

  const listHeader = useMemo(
    () => (
      <>
        {TIMELINE_LIST_HEADER}
        {canLoadOlder || isLoadingOlder || loadOlderError ? (
          <div className="mx-auto flex min-h-9 w-full max-w-3xl items-center justify-center px-3 pb-2 text-xs text-muted-foreground">
            {isLoadingOlder ? (
              <span role="status">Loading earlier history…</span>
            ) : (
              <Button size="sm" variant="ghost" onClick={onLoadOlder}>
                {loadOlderError ? "Retry earlier history" : "Load earlier history"}
              </Button>
            )}
          </div>
        ) : null}
      </>
    ),
    [canLoadOlder, isLoadingOlder, loadOlderError, onLoadOlder],
  );

  useEffect(() => {
    let removeListeners: (() => void) | null = null;
    let frame: number | null = null;

    const attach = (remainingAttempts: number) => {
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const scrollNode = listRef.current?.getScrollableNode?.();
        if (!(scrollNode instanceof HTMLElement)) {
          if (remainingAttempts > 0) attach(remainingAttempts - 1);
          return;
        }

        const contentOverflows = () => scrollNode.scrollHeight - scrollNode.clientHeight > 1;
        const viewportIsAwayFromEnd = () => !isTimelineScrolledToEnd(scrollNode);
        const breakLiveFollow = () => {
          markManualScrollIntent();
          onManualNavigation?.();
        };
        const handleWheel = (event: WheelEvent) => {
          if (!contentOverflows()) return;
          if (event.deltaY < 0) {
            // Upward navigation can only move away from the end. Do not arm
            // the "user reached end" latch: a responsive remeasurement that
            // temporarily reports the bottom must not turn live follow back
            // on after the user deliberately left it.
            onManualNavigation?.();
            return;
          }
          if (event.deltaY > 0) markManualScrollIntent();
        };
        const handleTouchMove = () => {
          markManualScrollIntent();
          if (viewportIsAwayFromEnd()) onManualNavigation?.();
        };
        const handlePointerDown = (event: PointerEvent) => {
          markManualScrollIntent();
          if (event.target === scrollNode ? contentOverflows() : viewportIsAwayFromEnd()) {
            onManualNavigation?.();
          }
        };
        const handleKeyDown = (event: KeyboardEvent) => {
          switch (event.key) {
            case "PageUp":
            case "Home":
            case "ArrowUp":
              if (contentOverflows()) breakLiveFollow();
              break;
            case "PageDown":
            case "End":
            case "ArrowDown":
              markManualScrollIntent();
              break;
            default:
              break;
          }
        };

        scrollNode.addEventListener("wheel", handleWheel, { passive: true });
        scrollNode.addEventListener("touchmove", handleTouchMove, {
          passive: true,
        });
        scrollNode.addEventListener("pointerdown", handlePointerDown, {
          passive: true,
        });
        scrollNode.addEventListener("keydown", handleKeyDown);
        removeListeners = () => {
          scrollNode.removeEventListener("wheel", handleWheel);
          scrollNode.removeEventListener("touchmove", handleTouchMove);
          scrollNode.removeEventListener("pointerdown", handlePointerDown);
          scrollNode.removeEventListener("keydown", handleKeyDown);
        };
      });
    };

    attach(12);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      removeListeners?.();
    };
  }, [listRef, markManualScrollIntent, onManualNavigation]);

  useEffect(
    () => () => {
      if (manualScrollIntentTimerRef.current !== null) {
        window.clearTimeout(manualScrollIntentTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const frame = requestAnimationFrame(handleScroll);
    return () => cancelAnimationFrame(frame);
  }, [handleScroll, rows.length]);

  // The scroller emits no event when rows grow, shrink, or finish measuring, so
  // re-check the bottom whenever LegendList republishes a content size. Without
  // this the pill survives a transcript that shrinks back under the viewport.
  useEffect(() => {
    if (!timelineViewportElement) {
      return;
    }
    const state = listRef.current?.getState?.();
    if (!state?.listen) {
      return;
    }
    const unsubscribes = [
      state.listen("totalSize", evaluateIsAtEnd),
      state.listen("headerSize", evaluateIsAtEnd),
      state.listen("footerSize", evaluateIsAtEnd),
    ];
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }, [evaluateIsAtEnd, listRef, timelineViewportElement]);

  useEffect(() => {
    if (!timelineViewportElement) {
      return;
    }

    const measure = () => {
      const viewportWidth = timelineViewportElement.getBoundingClientRect().width;
      const nextHasPersistentGutter = resolveTimelineMinimapHasPersistentGutter(viewportWidth);
      setMinimapHasPersistentGutter((current) =>
        current === nextHasPersistentGutter ? current : nextHasPersistentGutter,
      );
      setMinimapHitStripWidth(resolveTimelineMinimapHitStripWidth(viewportWidth));
      // A shorter viewport can turn a non-scrolling transcript into a
      // scrolling one (and back), so the pill has to be re-decided here too.
      evaluateIsAtEnd();
    };

    const frame = requestAnimationFrame(measure);
    const observer = new ResizeObserver(measure);
    observer.observe(timelineViewportElement);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [evaluateIsAtEnd, timelineViewportElement]);

  const previousRowCountRef = useRef(rows.length);
  useEffect(() => {
    const previousRowCount = previousRowCountRef.current;
    previousRowCountRef.current = rows.length;

    if (previousRowCount > 0 || rows.length === 0) {
      return;
    }

    onIsAtEndChange(true);
    const frameId = window.requestAnimationFrame(() => {
      void listRef.current?.scrollToEnd?.({ animated: false });
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [listRef, onIsAtEndChange, rows.length]);

  useEffect(() => {
    if (targetMessageId === null) {
      setHighlightedMessageId(null);
      return;
    }

    const targetRowIndex = rows.findIndex(
      (row) => row.kind === "message" && row.message.id === targetMessageId,
    );
    if (targetRowIndex < 0) {
      setHighlightedMessageId(null);
      return;
    }

    setHighlightedMessageId(targetMessageRowHighlight ? targetMessageId : null);
    onManualNavigation?.();
    void listRef.current?.scrollToIndex?.({
      animated: true,
      index: targetRowIndex,
      viewPosition: 0.45,
    });

    const frameId = window.requestAnimationFrame(() => {
      if (!targetMessageRowHighlight) {
        const activeSearchHit = document.querySelector<HTMLElement>(
          '[data-thread-message-search-active="true"]',
        );
        if (activeSearchHit) {
          activeSearchHit.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
          return;
        }
      }
      for (const element of document.querySelectorAll<HTMLElement>("[data-message-id]")) {
        if (element.dataset.messageId === targetMessageId) {
          element.scrollIntoView({ behavior: "smooth", block: "center" });
          break;
        }
      }
    });
    const timeoutId = window.setTimeout(() => {
      setHighlightedMessageId((current) => (current === targetMessageId ? null : current));
    }, MESSAGE_SEARCH_HIGHLIGHT_DURATION_MS);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(timeoutId);
    };
  }, [
    listRef,
    onManualNavigation,
    rows,
    targetMessageId,
    targetMessageRequestId,
    targetMessageRowHighlight,
  ]);

  // Streaming-frequent context — rebuilt on turn-lifecycle transitions.
  const streamingState = useMemo<TimelineStreamingState>(
    () =>
      buildTimelineStreamingState({
        activeTurnInProgress,
        activeTurnId: activeTurnId ?? null,
        isWorking,
        isRevertingCheckpoint,
        openDiffTurnId,
        agentPanelModel,
      }),
    [
      activeTurnInProgress,
      activeTurnId,
      agentPanelModel,
      isWorking,
      isRevertingCheckpoint,
      openDiffTurnId,
    ],
  );

  // Stable context — identity preserved across streaming transitions so rows
  // that only read stable state do not re-render. Callbacks from ChatView are
  // useCallback-stable.
  const stableState = useMemo<TimelineStableState>(
    () =>
      buildTimelineStableState({
        timestampFormat,
        routeThreadKey,
        markdownCwd,
        resolvedTheme,
        workspaceRoot,
        skills,
        activeThreadEnvironmentId,
        highlightedMessageId,
        threadMessageSearchQuery,
        threadMessageSearchOccurrencesByMessageId,
        activeThreadMessageSearchOccurrence,
        onRevertUserMessage,
        onUndoTurn,
        onImageExpand,
        onOpenTurnDiff,
        onCloseDiff: onCloseDiff ?? NOOP_CLOSE_DIFF,
        onOpenAgents,
        onOpenMessageActions,
        ...(onInspectContextHandoff ? { onInspectContextHandoff } : {}),
      }),
    [
      timestampFormat,
      routeThreadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      activeThreadEnvironmentId,
      highlightedMessageId,
      threadMessageSearchQuery,
      threadMessageSearchOccurrencesByMessageId,
      activeThreadMessageSearchOccurrence,
      onRevertUserMessage,
      onUndoTurn,
      onImageExpand,
      onOpenTurnDiff,
      onCloseDiff,
      onOpenAgents,
      onOpenMessageActions,
      onInspectContextHandoff,
    ],
  );

  // Stable renderItem — no closure deps. Row components read shared state
  // from the split timeline contexts, which propagate through LegendList's memo.
  const renderItem = useCallback(
    ({ item }: { item: MessagesTimelineRow }) => (
      <div className="mx-auto w-full min-w-0 max-w-3xl overflow-x-hidden" data-timeline-root="true">
        <TimelineRowContent row={item} />
      </div>
    ),
    [],
  );

  // A thread with nothing to show is rendered by `ChatView` as `NewThreadHero`
  // instead of mounting this timeline; the empty branch here only covers the
  // narrow window where an optimistic send has cleared the hero but no row has
  // materialized yet, so it stays blank rather than flashing placeholder copy.
  if (rows.length === 0 && !isWorking) {
    return <div aria-hidden className="h-full" />;
  }

  return (
    <TimelineStableCtx.Provider value={stableState}>
      <TimelineStreamingCtx.Provider value={streamingState}>
        <div ref={setTimelineViewportElement} className="relative h-full min-h-0">
          <LegendList<MessagesTimelineRow>
            ref={listRef}
            data={rows}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            estimatedItemSize={56}
            recycleItems={false}
            initialScrollAtEnd
            maintainScrollAtEnd={liveFollowEnabled}
            maintainScrollAtEndThreshold={0.1}
            maintainVisibleContentPosition
            onScroll={handleScroll}
            // The transcript scrolls without a visible scrollbar. Hiding it
            // also removes the gutter entirely, so the content column no longer
            // shifts when overflow appears — which is what `scrollbar-gutter:
            // stable` used to reserve space for.
            className="h-full overflow-x-hidden overscroll-y-contain px-3 [scrollbar-width:none] sm:px-5 [&::-webkit-scrollbar]:hidden"
            ListHeaderComponent={listHeader}
            ListFooterComponent={TIMELINE_LIST_FOOTER}
          />
          <TimelineMinimap
            hasPersistentGutter={minimapHasPersistentGutter}
            hitStripWidth={minimapHitStripWidth}
            items={minimapItems}
            stripMap={minimapStripMap}
            onSelect={(item) => {
              markManualScrollIntent();
              onManualNavigation?.();
              void listRef.current?.scrollToIndex({
                index: item.rowIndex,
                animated: true,
                viewOffset: 24,
              });
            }}
          />
        </div>
        <MessageActionsSheet
          target={messageActionsRequest}
          onOpenChange={(open) => {
            if (!open) setMessageActionsRequest(null);
          }}
          revertDisabled={isRevertingCheckpoint || isWorking}
          onRevert={() => {
            if (messageActionsRequest) {
              onRevertUserMessage(messageActionsRequest.messageId);
            }
          }}
        />
      </TimelineStreamingCtx.Provider>
    </TimelineStableCtx.Provider>
  );
});

function keyExtractor(item: MessagesTimelineRow) {
  return item.id;
}

interface TimelinePositionState {
  readonly scroll?: number;
  readonly scrollLength?: number;
  readonly positionAtIndex?: (index: number) => number | undefined;
  readonly sizeAtIndex?: (index: number) => number | undefined;
}

function resolveTimelineRowTop(state: TimelinePositionState, rowIndex: number): number | null {
  const top = state.positionAtIndex?.(rowIndex);
  return typeof top === "number" && Number.isFinite(top) ? top : null;
}

function resolveTimelineRowHeight(state: TimelinePositionState, rowIndex: number): number | null {
  const height = state.sizeAtIndex?.(rowIndex);
  return typeof height === "number" && Number.isFinite(height) ? height : null;
}

function timelineMinimapEventTargetsPreview(target: EventTarget): boolean {
  return target instanceof Element && target.closest("[data-minimap-preview]") !== null;
}

function TimelineMinimap({
  hasPersistentGutter,
  hitStripWidth,
  items,
  stripMap,
  onSelect,
}: {
  hasPersistentGutter: boolean;
  hitStripWidth: number;
  items: ReadonlyArray<TimelineMinimapItem>;
  stripMap: Map<string, HTMLSpanElement>;
  onSelect: (item: TimelineMinimapItem) => void;
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const resolvedActiveIndex =
    activeIndex !== null && activeIndex < items.length ? activeIndex : null;
  const activeItem = resolvedActiveIndex === null ? null : (items[resolvedActiveIndex] ?? null);
  const activeTopPercent =
    resolvedActiveIndex === null
      ? 0
      : resolveTimelineMinimapTopPercent(resolvedActiveIndex, items.length);
  const activeTooltipTranslate =
    resolvedActiveIndex === null
      ? "-50%"
      : resolvedActiveIndex === 0
        ? "0%"
        : resolvedActiveIndex === items.length - 1
          ? "-100%"
          : "-50%";

  const resolveActiveIndexFromPointer = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      return resolveTimelineMinimapIndexFromPointer({
        itemCount: items.length,
        railTop: rect.top,
        railHeight: rect.height,
        pointerY: event.clientY,
      });
    },
    [items.length],
  );

  const updateActiveIndexFromPointer = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      setActiveIndex(resolveActiveIndexFromPointer(event));
    },
    [resolveActiveIndexFromPointer],
  );

  const moveActiveIndex = useCallback(
    (delta: number) => {
      setActiveIndex((current) => {
        const base = current ?? 0;
        return Math.max(0, Math.min(items.length - 1, base + delta));
      });
    },
    [items.length],
  );

  if (items.length < TIMELINE_MINIMAP_MIN_ITEMS) {
    return null;
  }

  return (
    <div
      className="group/minimap pointer-events-none absolute inset-y-0 left-0 z-40 hidden w-18 opacity-100 [@media(pointer:fine)]:block"
      data-persistent-gutter={hasPersistentGutter ? "true" : "false"}
      data-testid="timeline-minimap"
    >
      <div className="relative h-full w-full select-none">
        <button
          aria-label={`Jump to message: ${activeItem?.userText ?? "User message"}`}
          className={cn(
            "absolute top-1/2 left-3 -translate-y-1/2 cursor-pointer bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
            hitStripWidth > 0 ? "pointer-events-auto" : "pointer-events-none",
          )}
          data-testid="timeline-minimap-hit-strip"
          onBlur={() => setActiveIndex(null)}
          onClick={(event) => {
            if (timelineMinimapEventTargetsPreview(event.target)) {
              return;
            }
            const nextIndex = resolveActiveIndexFromPointer(event);
            const nextItem = nextIndex === null ? null : (items[nextIndex] ?? null);
            if (nextItem) {
              onSelect(nextItem);
            }
            event.currentTarget.blur();
          }}
          onFocus={() => setActiveIndex((current) => current ?? 0)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveActiveIndex(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              moveActiveIndex(-1);
            } else if (event.key === "Home") {
              event.preventDefault();
              setActiveIndex(0);
            } else if (event.key === "End") {
              event.preventDefault();
              setActiveIndex(items.length - 1);
            } else if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              if (activeItem) {
                onSelect(activeItem);
              }
            }
          }}
          onMouseDown={(event) => {
            if (!timelineMinimapEventTargetsPreview(event.target)) {
              event.preventDefault();
            }
          }}
          onMouseLeave={() => setActiveIndex(null)}
          onMouseMove={updateActiveIndexFromPointer}
          style={{
            height: resolveTimelineMinimapHeightStyle(items.length),
            width: resolveTimelineMinimapInteractiveWidth(hitStripWidth, activeItem !== null),
          }}
          type="button"
        >
          <span aria-hidden="true" className="absolute top-0 left-3 h-full w-px bg-border/15" />
          {items.map((item, index) => {
            const activeDistance =
              resolvedActiveIndex === null ? null : Math.abs(index - resolvedActiveIndex);

            return (
              <span
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute left-0 h-0.5 -translate-y-1/2 rounded-full bg-muted-foreground/35 transition-[background-color,width] duration-150 data-[in-view=true]:bg-foreground/90",
                  activeDistance === 0
                    ? "w-6 bg-muted-foreground/75"
                    : activeDistance === 1
                      ? "w-4"
                      : activeDistance === 2
                        ? "w-2.5"
                        : "w-2",
                )}
                data-in-view="false"
                data-minimap-message-id={item.id}
                data-minimap-strip
                key={item.id}
                ref={(node) => {
                  if (node) {
                    stripMap.set(item.id, node);
                  } else {
                    stripMap.delete(item.id);
                  }
                }}
                style={{
                  top: `${resolveTimelineMinimapTopPercent(index, items.length)}%`,
                }}
              />
            );
          })}
          {activeItem ? (
            <span
              className="pointer-events-auto absolute left-8 w-80 cursor-text select-text"
              data-minimap-preview
              onMouseMove={(event) => event.stopPropagation()}
              style={{
                top: `${activeTopPercent}%`,
                transform: `translateY(${activeTooltipTranslate})`,
              }}
            >
              <span className="selection-glass-surface block rounded-xl border p-3 text-left text-popover-foreground">
                <span className="block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium leading-5">
                  {activeItem.userText ?? "User message"}
                </span>
                {activeItem.assistantText ? (
                  <span
                    className="mt-1 max-h-[3.75rem] overflow-hidden text-muted-foreground text-sm leading-5"
                    style={{
                      display: "-webkit-box",
                      WebkitBoxOrient: "vertical",
                      WebkitLineClamp: 3,
                    }}
                  >
                    {activeItem.assistantText}
                  </span>
                ) : null}
              </span>
            </span>
          ) : null}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TimelineRowContent — the actual row component
// ---------------------------------------------------------------------------

type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];
type TimelineRow = MessagesTimelineRow;

function TimelineRowContent({ row }: { row: TimelineRow }) {
  // This row renderer reads both contexts (it depends on streaming + stable
  // fields), so it re-renders on streaming transitions as before. The merged
  // object is local — it does not propagate through any context boundary.
  const ctx = { ...use(TimelineStableCtx), ...use(TimelineStreamingCtx) };
  // Phone tier: long-press on a message bubble opens the message action
  // sheet with the same copy/revert actions as the desktop hover row.
  const isPhoneTier = usePresentationTier() === "phone";
  const messageLongPress = useLongPress(
    () => {
      if (row.kind !== "message") return;
      if (row.message.role === "user") {
        const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text);
        const copyText = displayedUserMessage.copyText ?? null;
        const canRevert = typeof row.revertTurnCount === "number";
        // No actions apply (nothing to copy, no checkpoint): open no sheet.
        if (copyText === null && !canRevert) return;
        ctx.onOpenMessageActions({
          messageId: row.message.id,
          role: "user",
          copyText,
          canRevert,
        });
        return;
      }
      if (row.message.role !== "assistant") return;
      const assistantCopyState = resolveAssistantRowCopyState(row, ctx);
      const copyText = assistantCopyState.visible ? (assistantCopyState.text ?? null) : null;
      // A streaming or copy-ineligible response has no actions: open no sheet.
      if (copyText === null) return;
      ctx.onOpenMessageActions({
        messageId: row.message.id,
        role: "assistant",
        copyText,
        canRevert: false,
      });
    },
    { disabled: !isPhoneTier || row.kind !== "message" },
  );
  const isHighlightedMessage =
    row.kind === "message" && ctx.highlightedMessageId === row.message.id;
  const messageSearchOccurrences =
    row.kind === "message"
      ? ctx.threadMessageSearchOccurrencesByMessageId.get(row.message.id)
      : undefined;
  const messageSearchHighlight =
    row.kind === "message" &&
    messageSearchOccurrences !== undefined &&
    messageSearchOccurrences.length > 0 &&
    ctx.threadMessageSearchQuery.trim().length > 0
      ? {
          query: ctx.threadMessageSearchQuery,
          activeOccurrenceIndex:
            ctx.activeThreadMessageSearchOccurrence?.messageId === row.message.id
              ? ctx.activeThreadMessageSearchOccurrence.messageOccurrenceIndex
              : null,
        }
      : undefined;

  return (
    <div
      className={cn(
        row.kind === "work"
          ? "pb-0.5"
          : row.kind === "work-toggle" ||
              (row.kind === "message" &&
                row.message.role === "assistant" &&
                !row.showAssistantCopyButton)
            ? "pb-2"
            : "pb-4",
        row.kind === "message"
          ? "scroll-mt-12 rounded-xl transition-[background-color,box-shadow] duration-500"
          : null,
        isHighlightedMessage ? "bg-primary/10 ring-1 ring-primary/30" : null,
        row.kind === "message" && row.message.role === "assistant" ? "group/assistant" : null,
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-highlighted={isHighlightedMessage ? "true" : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {row.kind === "work" && <WorkGroupSection groupedEntries={row.groupedEntries} />}
      {row.kind === "work-toggle" && <WorkGroupToggleTimelineRow row={row} />}
      {row.kind === "turn-fold" && <TurnFoldTimelineRow row={row} />}

      {row.kind === "context-compaction" && (
        <ContextCompactionMarkerRow createdAt={row.createdAt} label={row.marker.label} />
      )}

      {row.kind === "context-handoff" && (
        <ContextHandoffMarkerRow
          marker={row.marker}
          {...(ctx.onInspectContextHandoff ? { onInspect: ctx.onInspectContextHandoff } : {})}
        />
      )}

      {row.kind === "message" &&
        row.message.role === "user" &&
        (() => {
          const userImages = row.message.attachments ?? [];
          const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text);
          const terminalContexts = displayedUserMessage.contexts;
          const canRevertAgentWork = typeof row.revertTurnCount === "number";
          return (
            <div className="flex justify-end">
              <div className="group flex max-w-[80%] flex-col items-end">
                <div
                  className="relative rounded-2xl rounded-br-sm bg-foreground/8 px-3 py-2 shadow-md/5 transition-[background-color,box-shadow] duration-200 group-hover:bg-foreground/10 group-hover:shadow-lg/8"
                  {...messageLongPress}
                >
                  <MessageAttachments
                    attachments={userImages}
                    variant="user"
                    onImageExpand={ctx.onImageExpand}
                    environmentId={ctx.activeThreadEnvironmentId}
                    threadId={parseScopedThreadKey(ctx.routeThreadKey)?.threadId}
                    messageId={row.message.id}
                  />
                  {(displayedUserMessage.visibleText.trim().length > 0 ||
                    terminalContexts.length > 0) && (
                    <UserMessageBody
                      text={displayedUserMessage.visibleText}
                      terminalContexts={terminalContexts}
                      skills={ctx.skills}
                      searchHighlight={messageSearchHighlight}
                    />
                  )}
                </div>
                <div className="mt-1 flex items-center justify-end gap-2">
                  <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100 phone:opacity-100">
                    {displayedUserMessage.copyText && (
                      <MessageCopyButton
                        text={displayedUserMessage.copyText}
                        size="icon-xs"
                        variant="ghost"
                        className={MESSAGE_ACTION_BUTTON_CLASS_NAME}
                        ariaLabel="Copy message"
                      />
                    )}
                    {canRevertAgentWork && (
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        className={MESSAGE_ACTION_BUTTON_CLASS_NAME}
                        disabled={ctx.isRevertingCheckpoint || ctx.isWorking}
                        onClick={() => ctx.onRevertUserMessage(row.message.id)}
                        title="Revert to this message"
                      >
                        <Undo2Icon className="size-3" />
                      </Button>
                    )}
                  </div>
                  <p className="text-right text-[11px] text-muted-foreground/50">
                    {row.message.dispatchMode === "steer" ? "Steered · " : ""}
                    {formatTimestamp(row.message.createdAt, ctx.timestampFormat)}
                  </p>
                </div>
              </div>
            </div>
          );
        })()}

      {row.kind === "message" &&
        row.message.role === "assistant" &&
        (() => {
          const messageText =
            row.message.text ||
            (row.message.streaming || row.message.attachments?.length ? "" : "(empty response)");
          const assistantResponseStillInProgress = resolveAssistantRowInProgress(row, ctx);
          const assistantCopyState = resolveAssistantRowCopyState(row, ctx);
          return (
            <>
              <div className="min-w-0 px-1 py-0.5" {...messageLongPress}>
                <ChatMarkdown
                  text={messageText}
                  cwd={ctx.markdownCwd}
                  environmentId={ctx.activeThreadEnvironmentId}
                  isStreaming={assistantResponseStillInProgress}
                  skills={ctx.skills}
                  searchHighlight={messageSearchHighlight}
                />
                <MessageAttachments
                  attachments={row.message.attachments ?? []}
                  onImageExpand={ctx.onImageExpand}
                  environmentId={ctx.activeThreadEnvironmentId}
                  threadId={parseScopedThreadKey(ctx.routeThreadKey)?.threadId}
                  messageId={row.message.id}
                />
                {!assistantResponseStillInProgress && (
                  <AssistantChangedFilesSection
                    turnSummary={row.assistantTurnDiffSummary}
                    undoTurnCount={row.assistantUndoTurnCount}
                    routeThreadKey={ctx.routeThreadKey}
                    resolvedTheme={ctx.resolvedTheme}
                    openDiffTurnId={ctx.openDiffTurnId}
                    onOpenTurnDiff={ctx.onOpenTurnDiff}
                    onCloseDiff={ctx.onCloseDiff}
                  />
                )}
                <div className="mt-1.5 flex items-center gap-2">
                  <p className="text-[10px] text-muted-foreground/30">
                    {row.message.streaming ? (
                      <LiveMessageMeta
                        createdAt={row.message.createdAt}
                        durationStart={row.durationStart}
                        timestampFormat={ctx.timestampFormat}
                      />
                    ) : (
                      formatMessageMeta(
                        row.message.createdAt,
                        formatElapsed(row.durationStart, row.message.completedAt),
                        ctx.timestampFormat,
                      )
                    )}
                  </p>
                  {assistantCopyState.visible ? (
                    <div className="flex items-center opacity-0 transition-opacity duration-200 group-hover/assistant:opacity-100 phone:opacity-100">
                      <MessageCopyButton
                        text={assistantCopyState.text ?? ""}
                        size="icon-xs"
                        variant="ghost"
                        className={MESSAGE_ACTION_BUTTON_CLASS_NAME}
                        ariaLabel="Copy response"
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            </>
          );
        })()}

      {row.kind === "proposed-plan" && (
        <div className="min-w-0 px-1 py-0.5">
          <ProposedPlanCard
            planMarkdown={row.proposedPlan.planMarkdown}
            environmentId={ctx.activeThreadEnvironmentId}
            cwd={ctx.markdownCwd}
            workspaceRoot={ctx.workspaceRoot}
          />
        </div>
      )}

      {row.kind === "working" && <PendingWorkingTimelineRow row={row} />}
    </div>
  );
}

// The settled turn's disclosure and its live twin share one label tone, size,
// and full-width divider, so a turn folding shut is a status change rather than
// a change of shape. The label box stays flush with the timeline's content edge:
// nudging it left to compensate for the leading "W" side bearing pushed the
// glyph past the scroll container's clip and shaved its left stem.
const TURN_FOLD_LABEL_CLASS_NAME = "text-[13px] text-muted-foreground/70 tabular-nums";

function TurnFoldTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "turn-fold" }> }) {
  const { routeThreadKey } = use(TimelineStableCtx);
  const setExpanded = useUiStateStore((store) => store.setThreadTurnFoldExpanded);

  return (
    <div className="pt-1 pb-2" data-turn-fold-status={row.status}>
      <button
        type="button"
        aria-expanded={row.expanded}
        onClick={() => setExpanded(routeThreadKey, row.foldId, !row.expanded)}
        className={cn(
          TURN_FOLD_LABEL_CLASS_NAME,
          "flex cursor-pointer select-none items-center gap-1 pb-2 transition-colors duration-200 hover:text-muted-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        )}
      >
        <span>
          {row.status === "running" ? (
            row.durationStart ? (
              <>
                Working for <WorkingTimer createdAt={row.durationStart} />
              </>
            ) : (
              "Working…"
            )
          ) : (
            (row.label ?? "Worked")
          )}
        </span>
        <DisclosureChevron open={row.expanded} className="text-muted-foreground/55" />
      </button>
      <div className="h-px w-full bg-border" />
    </div>
  );
}

/**
 * The live twin of a settled turn's "Worked for …" disclosure: the same label
 * tone and divider counting up, with a waving "Thinking" line beneath it so an
 * agent that has not emitted anything yet still reads as busy rather than stuck.
 */
function PendingWorkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "working" }> }) {
  return (
    <div className="pt-1 pb-2">
      {row.createdAt ? (
        <>
          <div className={cn(TURN_FOLD_LABEL_CLASS_NAME, "flex items-center pb-2")}>
            Working for <WorkingTimer createdAt={row.createdAt} />
          </div>
          <div className="h-px w-full bg-border" />
        </>
      ) : null}
      <div className="pt-1.5 text-[13px] text-muted-foreground/70">
        <span className="shimmer thinking-status-shimmer">Thinking</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-ticking labels update their own text nodes so elapsed-time display does
// not create a React commit every second while a response is streaming.
// ---------------------------------------------------------------------------

/** Live "Working for Xs" label. */
function WorkingTimer({ createdAt }: { createdAt: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatWorkingTimerNow(createdAt);

  useEffect(() => {
    const updateText = (nowMs: number) => {
      if (textRef.current) {
        textRef.current.textContent = formatWorkingTimerNow(createdAt, nowMs);
      }
    };
    return visibleSecondTicker.subscribe(updateText);
  }, [createdAt]);

  return <span ref={textRef}>{initialText}</span>;
}

/** Live timestamp + elapsed duration for a streaming assistant message. */
function LiveMessageMeta({
  createdAt,
  durationStart,
  timestampFormat,
}: {
  createdAt: string;
  durationStart: string | null | undefined;
  timestampFormat: TimestampFormat;
}) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatLiveMessageMetaNow(createdAt, durationStart, timestampFormat);

  useEffect(() => {
    const updateText = (nowMs: number) => {
      if (textRef.current) {
        textRef.current.textContent = formatLiveMessageMetaNow(
          createdAt,
          durationStart,
          timestampFormat,
          nowMs,
        );
      }
    };
    if (!durationStart) {
      updateText(Date.now());
      return;
    }
    return visibleSecondTicker.subscribe(updateText);
  }, [createdAt, durationStart, timestampFormat]);

  return <span ref={textRef}>{initialText}</span>;
}

// ---------------------------------------------------------------------------
// Extracted row sections — own their state / store subscriptions so changes
// re-render only the affected row, not the entire list.
// ---------------------------------------------------------------------------

const COMPACT_WORK_ROW_CLASS_NAME =
  "group/tool-row grid min-h-[30px] w-full grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-md px-2 text-left";

// One muted resting tone for a tool row's glyph, label, and chevron; the whole
// row brightens to foreground together on hover/focus instead of taking a fill.
const WORK_ROW_TONE_CLASS_NAME =
  "text-muted-foreground/70 transition-colors duration-200 group-hover/tool-row:text-foreground group-focus-visible/tool-row:text-foreground";

/** Renders one already-derived group while individual entry state stays row-local. */
const WorkGroupSection = memo(function WorkGroupSection({
  groupedEntries,
}: {
  groupedEntries: Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"];
}) {
  const { activeTurnId, isWorking } = use(TimelineStreamingCtx);
  const { workspaceRoot } = use(TimelineStableCtx);
  // The frozen phone tier has no Agents workspace, so spawn CTAs render as
  // plain work rows there instead of dead-end navigation affordances.
  const isPhoneTier = usePresentationTier() === "phone";
  const onlyToolEntries = groupedEntries.every((entry) => entry.tone === "tool");
  const groupLabel = onlyToolEntries ? "Tool calls" : "Work log";

  return (
    <div className="space-y-1">
      {!onlyToolEntries && (
        <div className="flex items-center gap-2 px-2">
          <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/55">
            {groupLabel} ({groupedEntries.length})
          </p>
        </div>
      )}
      <div className="space-y-0.5">
        {groupedEntries.map((workEntry) => {
          const isActive =
            isWorking &&
            activeTurnId !== null &&
            activeTurnId !== undefined &&
            workEntry.turnId === activeTurnId;

          if (workEntry.agentSpawn && !isPhoneTier) {
            return <AgentSpawnCtaRow key={`work-row:${workEntry.id}`} workEntry={workEntry} />;
          }

          if (isFileEditWorkEntry(workEntry) && (workEntry.changedFiles?.length ?? 0) > 0) {
            return (
              <FileEditWorkEntryRow
                key={`work-row:${workEntry.id}`}
                isEditing={isActive && !workEntry.completed && !isErroredWorkEntry(workEntry)}
                workEntry={workEntry}
                workspaceRoot={workspaceRoot}
              />
            );
          }

          return (
            <ExpandableWorkEntryRow
              key={`work-row:${workEntry.id}`}
              workEntry={workEntry}
              workspaceRoot={workspaceRoot}
            />
          );
        })}
      </div>
    </div>
  );
});

/**
 * Spawn CTA: one anchored row per workflow run (or per-turn direct-spawn
 * batch). Live status is derived from the shared agent panel model at render
 * time — the row itself never carries a roster; the Agents panel is the only
 * roster. Freezes to past tense when every member settles. Static dot, no
 * animation.
 */
const AgentSpawnCtaRow = memo(function AgentSpawnCtaRow(props: { workEntry: TimelineWorkEntry }) {
  const { workEntry } = props;
  const { agentPanelModel } = use(TimelineStreamingCtx);
  const { onOpenAgents } = use(TimelineStableCtx);
  const spawn = workEntry.agentSpawn;
  if (!spawn) {
    return null;
  }

  const memberIds = new Set(spawn.agentTaskIds);
  const workflowGroup = spawn.workflowId
    ? agentPanelModel.workflows.find((group) => group.workflow.id === spawn.workflowId)
    : undefined;
  const agents = workflowGroup
    ? [...workflowGroup.phases.flatMap((phase) => phase.members), ...workflowGroup.unphasedMembers]
    : agentPanelModel.directAgents.filter((agent) => memberIds.has(agent.id));
  const agentCount = Math.max(
    agents.length,
    Math.max(memberIds.size - (spawn.workflowId ? 1 : 0), 0),
  );

  const running = agents.filter(
    (agent) => agent.status === "running" || agent.status === "pending",
  ).length;
  const waiting = agents.filter((agent) => agent.status === "waiting").length;
  const failed = agents.filter((agent) => agent.status === "failed").length;
  // The coordinator's own status is authoritative for workflows: dynamic
  // spawns mean the member list can be momentarily all-settled while the
  // run is still mid-flight. A workflow is live until the coordinator
  // itself reaches a terminal state.
  const coordinatorStatus = workflowGroup?.workflow.status;
  const coordinatorSettled =
    coordinatorStatus === "completed" ||
    coordinatorStatus === "failed" ||
    coordinatorStatus === "cancelled" ||
    coordinatorStatus === "interrupted";
  const live = workflowGroup !== undefined ? !coordinatorSettled : running + waiting > 0;
  // Same rule as the panel footer: providers may aggregate member usage into
  // the coordinator, so count the coordinator only when no members exist.
  const totalTokens = agents.reduce(
    (sum, agent) => sum + (agent.usage?.totalTokens ?? 0),
    spawn.workflowId && agents.length === 0 ? (workflowGroup?.workflow.usage?.totalTokens ?? 0) : 0,
  );

  const livePhase = workflowGroup?.phases.find((phase) => phase.state === "running");
  const workflowName =
    workflowGroup?.workflow.workflowName ?? workflowGroup?.workflow.title ?? null;

  // One steady in-flight presentation: waiting and stalled agents read as
  // working; only settled states differentiate.
  const working = running + waiting;
  const dotClass = live ? "bg-info" : failed > 0 ? "bg-destructive" : "bg-success";
  const lead = live
    ? `Kicked off ${agentCount} subagent${agentCount === 1 ? "" : "s"}`
    : `Ran ${agentCount} subagent${agentCount === 1 ? "" : "s"}`;
  const status = live
    ? livePhase
      ? `${livePhase.title} · ${livePhase.activeCount} working`
      : working > 0
        ? `${working} working`
        : "Working"
    : failed > 0
      ? `${failed} failed`
      : "Completed";

  return (
    <button
      type="button"
      onClick={onOpenAgents}
      aria-label={live ? "Open the Agents panel" : "View agents"}
      className={cn(
        glassSurfaceClassName("chip"),
        "group/agent-cta grid min-h-[36px] w-full grid-cols-[1.25rem_minmax(0,1fr)_auto_1.25rem] items-center gap-x-2 rounded-lg border border-border/50 px-2 text-left transition-colors hover:border-border/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
      )}
    >
      <span className="flex size-5 items-center justify-center">
        <BotIcon
          aria-hidden
          className="size-3.5 text-muted-foreground/70 transition-colors group-hover/agent-cta:text-foreground"
        />
      </span>
      <span className="flex min-w-0 items-center gap-2">
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dotClass)} />
        <span className="truncate text-[12px] leading-5">
          <span className="font-medium text-foreground/90">{lead}</span>
          {workflowName ? <span className="text-muted-foreground"> · {workflowName}</span> : null}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2 text-[11px] leading-5 text-muted-foreground">
        <span>{status}</span>
        {totalTokens > 0 ? (
          <span className="tabular-nums">{formatSubagentTokenCount(totalTokens)} tok</span>
        ) : null}
      </span>
      <span className="flex size-5 items-center justify-center">
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 text-muted-foreground/60 transition-[color,translate] group-hover/agent-cta:translate-x-0.5 group-hover/agent-cta:text-foreground"
        />
      </span>
    </button>
  );
});

function WorkGroupToggleTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "work-toggle" }>;
}) {
  const { routeThreadKey } = use(TimelineStableCtx);
  const setExpanded = useUiStateStore((store) => store.setThreadWorkGroupExpanded);
  const labelNoun = row.onlyToolEntries
    ? row.hiddenCount === 1
      ? "tool call"
      : "tool calls"
    : row.hiddenCount === 1
      ? "log entry"
      : "log entries";
  // A recap only exists for a settled run of plain tool calls; anything else
  // (errors, approvals, a single hidden row) keeps the explicit count.
  const label =
    row.summary && !row.summary.hasRunningEntry
      ? row.summary.label
      : `+${row.hiddenCount} previous ${labelNoun}`;
  const SummaryIcon = row.summary ? workEntryIcon(row.summary.iconEntry) : ChevronDownIcon;

  return (
    <button
      type="button"
      aria-expanded={row.expanded}
      onClick={() => setExpanded(routeThreadKey, row.groupId, !row.expanded)}
      data-work-group-toggle="true"
      className={cn(
        COMPACT_WORK_ROW_CLASS_NAME,
        "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
      )}
    >
      {/* The recap wears its first folded entry's glyph, so collapsing a run
          keeps the leading icon of the row it hides. */}
      <span className={cn("flex size-5 items-center justify-center", WORK_ROW_TONE_CLASS_NAME)}>
        <SummaryIcon className="size-3.5" aria-hidden />
      </span>
      <span className={cn("truncate text-[12px] leading-5", WORK_ROW_TONE_CLASS_NAME)}>
        {label}
      </span>
      <span className="flex size-5 items-center justify-center">
        <DisclosureChevron open={row.expanded} className={cn("size-3", WORK_ROW_TONE_CLASS_NAME)} />
      </span>
    </button>
  );
}

const ContextCompactionMarkerRow = memo(function ContextCompactionMarkerRow({
  createdAt,
  label,
}: {
  createdAt: string;
  label: string;
}) {
  const { timestampFormat } = use(TimelineStableCtx);
  const timestamp = formatTimestamp(createdAt, timestampFormat);

  return (
    <div className="flex items-center gap-3 py-1.5" aria-label={`${label} at ${timestamp}`}>
      <span className="h-px flex-1 bg-border/55" />
      <span className="inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border border-border/60 bg-muted/35 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/75">
        <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/35" />
        <span className="truncate">{label}</span>
        <span className="shrink-0 font-normal normal-case tracking-normal text-muted-foreground/45">
          {timestamp}
        </span>
      </span>
      <span className="h-px flex-1 bg-border/55" />
    </div>
  );
});

/** Subscribes directly to the UI state store for expand/collapse state,
 *  so toggling re-renders only this component — not the entire list. */
const AssistantChangedFilesSection = memo(function AssistantChangedFilesSection({
  turnSummary,
  undoTurnCount,
  routeThreadKey,
  resolvedTheme,
  openDiffTurnId,
  onOpenTurnDiff,
  onCloseDiff,
}: {
  turnSummary: TurnDiffSummary | undefined;
  undoTurnCount: number | undefined;
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  openDiffTurnId: TurnId | null;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onCloseDiff: () => void;
}) {
  if (!turnSummary) return null;
  const checkpointFiles = turnSummary.files;
  if (checkpointFiles.length === 0) return null;

  return (
    <AssistantChangedFilesSectionInner
      turnSummary={turnSummary}
      checkpointFiles={checkpointFiles}
      undoTurnCount={undoTurnCount}
      routeThreadKey={routeThreadKey}
      resolvedTheme={resolvedTheme}
      openDiffTurnId={openDiffTurnId}
      onOpenTurnDiff={onOpenTurnDiff}
      onCloseDiff={onCloseDiff}
    />
  );
});

// Long file lists collapse to this many rows; the rest hide behind "Show N more".
const MAX_VISIBLE_CHANGED_FILES = 6;

/** Inner component that only mounts when there are actual changed files,
 *  so the store subscription is unconditional (no hooks after early return). */
function AssistantChangedFilesSectionInner({
  turnSummary,
  checkpointFiles,
  undoTurnCount,
  routeThreadKey,
  resolvedTheme,
  openDiffTurnId,
  onOpenTurnDiff,
  onCloseDiff,
}: {
  turnSummary: TurnDiffSummary;
  checkpointFiles: TurnDiffSummary["files"];
  undoTurnCount: number | undefined;
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  openDiffTurnId: TurnId | null;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onCloseDiff: () => void;
}) {
  const { onUndoTurn } = use(TimelineStableCtx);
  const { isRevertingCheckpoint } = use(TimelineStreamingCtx);
  const expanded = useUiStateStore(
    (store) => store.threadChangedFilesExpandedById[routeThreadKey]?.[turnSummary.turnId] ?? true,
  );
  const setExpanded = useUiStateStore((store) => store.setThreadChangedFilesExpanded);
  const [fileListExpanded, setFileListExpanded] = useState(false);

  const summaryStat = summarizeTurnDiffStats(checkpointFiles);
  const diffOpenForTurn = openDiffTurnId === turnSummary.turnId;
  const editedFilesLabel = `Edited ${checkpointFiles.length} ${
    checkpointFiles.length === 1 ? "file" : "files"
  }`;
  const visibleFiles = fileListExpanded
    ? checkpointFiles
    : checkpointFiles.slice(0, MAX_VISIBLE_CHANGED_FILES);
  const overflowCount = checkpointFiles.length - visibleFiles.length;
  const canUndo = undoTurnCount !== undefined;

  return (
    <div className="chat-final-diff-section mt-2 mb-1 overflow-hidden rounded-[0.65rem] border border-border/70">
      <div
        className={cn(
          "flex items-center justify-between gap-3 bg-muted/40 px-3 py-1.5",
          expanded && "border-b border-border/70",
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <FileDiffIcon className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
          <div className="min-w-0">
            <div className="truncate text-[12px] text-foreground/92">{editedFilesLabel}</div>
            {hasNonZeroStat(summaryStat) && (
              <div className="text-[12px] tabular-nums">
                <DiffStatLabel
                  additions={summaryStat.additions}
                  deletions={summaryStat.deletions}
                />
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {canUndo && (
            <button
              type="button"
              data-changed-files-undo="true"
              disabled={isRevertingCheckpoint}
              className="flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => onUndoTurn(undoTurnCount)}
            >
              Undo
              <Undo2Icon className="size-3" aria-hidden />
            </button>
          )}
          <button
            type="button"
            className="text-[12px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => {
              if (diffOpenForTurn) {
                onCloseDiff();
                return;
              }
              onOpenTurnDiff(turnSummary.turnId, checkpointFiles[0]?.path);
            }}
          >
            {diffOpenForTurn ? "Close diff" : "Review changes"}
          </button>
          <button
            type="button"
            data-scroll-anchor-ignore
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse changed files list" : "Expand changed files list"}
            className="inline-flex items-center justify-center rounded-md p-1 text-muted-foreground/70 transition-colors hover:bg-foreground/5 hover:text-foreground/80"
            onClick={() => setExpanded(routeThreadKey, turnSummary.turnId, !expanded)}
          >
            <DisclosureChevron open={expanded} className="size-3.5" />
          </button>
        </div>
      </div>
      <DisclosureRegion open={expanded}>
        {visibleFiles.map((file) => (
          <ChangedFileRow
            key={file.path}
            file={file}
            resolvedTheme={resolvedTheme}
            onOpen={() => onOpenTurnDiff(turnSummary.turnId, file.path)}
          />
        ))}
        {overflowCount > 0 || fileListExpanded ? (
          <button
            type="button"
            data-scroll-anchor-ignore
            aria-expanded={fileListExpanded}
            className="flex w-full items-center gap-1.5 border-t border-border/70 px-3 py-2 text-[12px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            onClick={() => setFileListExpanded(!fileListExpanded)}
          >
            <DisclosureChevron open={fileListExpanded} className="size-3.5" />
            <span>
              {fileListExpanded
                ? "Show less"
                : `Show ${overflowCount} more ${overflowCount === 1 ? "file" : "files"}`}
            </span>
          </button>
        ) : null}
      </DisclosureRegion>
    </div>
  );
}

/** One file in the changed-files card: icon, path, and its own +N/-M. */
function ChangedFileRow(props: {
  file: TurnDiffSummary["files"][number];
  resolvedTheme: "light" | "dark";
  onOpen: () => void;
}) {
  const { file, resolvedTheme, onOpen } = props;
  const additions = file.additions ?? 0;
  const deletions = file.deletions ?? 0;
  const hasDiffStat = additions + deletions > 0;

  return (
    <button
      type="button"
      data-changed-file-row="true"
      title={file.path}
      className="group/file-row flex w-full items-center gap-2 border-t border-border/70 px-3 py-2 text-left transition-colors first:border-t-0 hover:bg-foreground/5"
      onClick={onOpen}
    >
      <VscodeEntryIcon
        pathValue={file.path}
        kind="file"
        theme={resolvedTheme}
        className="size-4 shrink-0 opacity-80"
      />
      <span className="truncate text-[12px] text-foreground/88 underline-offset-2 group-hover/file-row:underline">
        {file.path}
      </span>
      {hasDiffStat && (
        <span className="ml-auto shrink-0 text-[12px] tabular-nums">
          <DiffStatLabel additions={additions} deletions={deletions} />
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Leaf components
// ---------------------------------------------------------------------------

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />;
  },
);

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  searchHighlight?: Omit<SkillInlineTextSearchHighlight, "cursor" | "keyPrefix"> | undefined;
}) {
  const searchHighlightCursorRef = useRef({ occurrenceIndex: 0 });
  searchHighlightCursorRef.current.occurrenceIndex = 0;
  const searchHighlight = props.searchHighlight
    ? {
        ...props.searchHighlight,
        cursor: searchHighlightCursorRef.current,
        keyPrefix: "user-message",
      }
    : undefined;

  if (props.terminalContexts.length > 0) {
    const hasEmbeddedInlineLabels = textContainsInlineTerminalContextLabels(
      props.text,
      props.terminalContexts,
    );
    const inlinePrefix = buildInlineTerminalContextText(props.terminalContexts);
    const inlineNodes: ReactNode[] = [];

    if (hasEmbeddedInlineLabels) {
      let cursor = 0;

      for (const context of props.terminalContexts) {
        const label = formatInlineTerminalContextLabel(context.header);
        const matchIndex = props.text.indexOf(label, cursor);
        if (matchIndex === -1) {
          inlineNodes.length = 0;
          break;
        }
        if (matchIndex > cursor) {
          inlineNodes.push(
            <span key={`user-terminal-context-inline-before:${context.header}:${cursor}`}>
              <SkillInlineText
                text={props.text.slice(cursor, matchIndex)}
                skills={props.skills}
                searchHighlight={searchHighlight}
              />
            </span>,
          );
        }
        inlineNodes.push(
          <UserMessageTerminalContextInlineLabel
            key={`user-terminal-context-inline:${context.header}`}
            context={context}
          />,
        );
        cursor = matchIndex + label.length;
      }

      if (inlineNodes.length > 0) {
        if (cursor < props.text.length) {
          inlineNodes.push(
            <span key={`user-message-terminal-context-inline-rest:${cursor}`}>
              <SkillInlineText
                text={props.text.slice(cursor)}
                skills={props.skills}
                searchHighlight={searchHighlight}
              />
            </span>,
          );
        }

        return (
          <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
            {inlineNodes}
          </div>
        );
      }
    }

    for (const context of props.terminalContexts) {
      inlineNodes.push(
        <UserMessageTerminalContextInlineLabel
          key={`user-terminal-context-inline:${context.header}`}
          context={context}
        />,
      );
      inlineNodes.push(
        <span key={`user-terminal-context-inline-space:${context.header}`} aria-hidden="true">
          {" "}
        </span>,
      );
    }

    if (props.text.length > 0) {
      inlineNodes.push(
        <span key="user-message-terminal-context-inline-text">
          <SkillInlineText
            text={props.text}
            skills={props.skills}
            searchHighlight={searchHighlight}
          />
        </span>,
      );
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  return (
    <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
      <SkillInlineText text={props.text} skills={props.skills} searchHighlight={searchHighlight} />
    </div>
  );
});

// ---------------------------------------------------------------------------
// Structural sharing — reuse old row references when data hasn't changed
// so LegendList (and React) can skip re-rendering unchanged items.
// ---------------------------------------------------------------------------

/** Returns a structurally-shared copy of `rows`: for each row whose content
 *  hasn't changed since last call, the previous object reference is reused. */
function useStableRows(rows: MessagesTimelineRow[]): MessagesTimelineRow[] {
  const prevState = useRef<StableMessagesTimelineRowsState>({
    byId: new Map<string, MessagesTimelineRow>(),
    result: [],
  });

  return useMemo(() => {
    const nextState = computeStableMessagesTimelineRows(rows, prevState.current);
    prevState.current = nextState;
    return nextState.result;
  }, [rows]);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

type TimelineMessageRow = Extract<MessagesTimelineRow, { kind: "message" }>;

/** Shared by the assistant JSX and the phone long-press handler so the copy
 *  affordance and the action sheet can never disagree about availability. */
function resolveAssistantRowInProgress(
  row: TimelineMessageRow,
  ctx: Pick<TimelineStreamingState, "activeTurnInProgress" | "activeTurnId">,
): boolean {
  const assistantTurnStillInProgress =
    ctx.activeTurnInProgress &&
    ctx.activeTurnId !== null &&
    ctx.activeTurnId !== undefined &&
    row.message.turnId === ctx.activeTurnId;
  const assistantSummaryStillInProgress =
    ctx.activeTurnInProgress &&
    ctx.activeTurnId !== null &&
    ctx.activeTurnId !== undefined &&
    row.assistantTurnDiffSummary?.turnId === ctx.activeTurnId;
  return Boolean(
    row.message.streaming || assistantTurnStillInProgress || assistantSummaryStillInProgress,
  );
}

function resolveAssistantRowCopyState(
  row: TimelineMessageRow,
  ctx: Pick<TimelineStreamingState, "activeTurnInProgress" | "activeTurnId">,
): ReturnType<typeof resolveAssistantMessageCopyState> {
  return resolveAssistantMessageCopyState({
    text: row.message.text ?? null,
    showCopyButton: row.showAssistantCopyButton,
    streaming: resolveAssistantRowInProgress(row, ctx),
  });
}

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatWorkingTimerNow(startIso: string, nowMs: number = Date.now()): string {
  return formatWorkingTimer(startIso, new Date(nowMs).toISOString()) ?? "0s";
}

function formatLiveMessageMetaNow(
  createdAt: string,
  durationStart: string | null | undefined,
  timestampFormat: TimestampFormat,
  nowMs: number = Date.now(),
): string {
  const elapsed = durationStart
    ? formatElapsed(durationStart, new Date(nowMs).toISOString())
    : null;
  return formatMessageMeta(createdAt, elapsed, timestampFormat);
}

function formatMessageMeta(
  createdAt: string,
  duration: string | null,
  timestampFormat: TimestampFormat,
): string {
  if (!duration) return formatTimestamp(createdAt, timestampFormat);
  return `${formatTimestamp(createdAt, timestampFormat)} • ${duration}`;
}

function workToneIcon(tone: TimelineWorkEntry["tone"]): LucideIcon {
  if (tone === "error") return CircleAlertIcon;
  if (tone === "thinking") return BotIcon;
  if (tone === "info") return CheckIcon;
  return ZapIcon;
}

/**
 * The short trailing phrase after the row's verb: the humanized command target,
 * a filename, or a clean detail line. Returns null when the heading already
 * says everything, so a row never reads "Read - Read".
 */
function workEntryPreview(
  workEntry: Pick<
    TimelineWorkEntry,
    "detail" | "command" | "rawCommand" | "changedFiles" | "requestKind" | "itemType"
  >,
  workspaceRoot: string | undefined,
): string | null {
  const command = workEntry.command ?? workEntry.rawCommand;
  if (command) {
    return deriveReadableCommandDisplay(command).target;
  }

  if ((workEntry.changedFiles?.length ?? 0) > 0) {
    const changedFiles = workEntry.changedFiles!;
    const [firstPath] = changedFiles;
    if (firstPath) {
      return changedFiles.length === 1
        ? basenameOfPath(formatWorkspaceRelativePath(firstPath, workspaceRoot))
        : `${changedFiles.length} files`;
    }
  }

  const detail = workEntry.detail?.trim();
  if (!detail) {
    return null;
  }

  const filePath = extractFilePathFromDetail(detail);
  if (filePath) {
    return basenameOfPath(filePath);
  }

  const isFileRelated =
    workEntry.requestKind === "file-read" ||
    workEntry.requestKind === "file-change" ||
    workEntry.itemType === "file_change";
  // For file rows the heading alone is enough — never surface raw arguments.
  if (isFileRelated) {
    return null;
  }
  if (detail.startsWith("{") || detail.startsWith("[")) {
    return null;
  }
  return detail;
}

/**
 * Pulls a file path out of a detail string that may be a JSON argument blob,
 * so a `Read {"file_path":"/a/b.ts"}` row can show just `b.ts`.
 */
function extractFilePathFromDetail(detail: string): string | null {
  const plainPathMatch = /^(.+?\.[A-Za-z0-9][A-Za-z0-9._-]*)(?::\d+)?(?::\d+)?$/u.exec(
    detail.trim(),
  );
  if (plainPathMatch?.[1]?.includes("/")) {
    return plainPathMatch[1].trim();
  }
  const jsonMatch = /"(?:file_path|filePath|path|filename)"\s*:\s*"([^"]+)"/u.exec(detail);
  return jsonMatch?.[1]?.trim() ?? null;
}

function workEntryRawCommand(
  workEntry: Pick<TimelineWorkEntry, "command" | "rawCommand">,
): string | null {
  return workEntry.rawCommand?.trim() || workEntry.command?.trim() || null;
}

// Command rows reuse the wrapper-aware classifier so wrapped git/gh commands get
// the branch mark and read-only inspections get the search glyph, rather than
// every command collapsing to one terminal icon.
function commandWorkEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  const command = workEntry.command ?? workEntry.rawCommand;
  switch (command ? resolveCommandVisualKind(command) : "terminal") {
    case "inspect":
      return SearchIcon;
    case "git":
    case "github":
      return GitBranchIcon;
    case "terminal":
      return TerminalIcon;
  }
}

// Provider read tools (e.g. Claude's `Read`) arrive as generic dynamic tool calls
// without a `file-read` requestKind, so match the tool name to surface the search
// icon instead of the generic tool fallback.
function isFileReadToolEntry(workEntry: TimelineWorkEntry): boolean {
  const name = (workEntry.toolTitle ?? "").toLowerCase().replace(/[^a-z]/g, "");
  return name === "read" || name === "readfile" || name === "viewfile";
}

function workEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  if (isErroredWorkEntry(workEntry)) return CircleAlertIcon;
  if (workEntry.requestKind === "command") return commandWorkEntryIcon(workEntry);
  if (workEntry.requestKind === "file-read") return SearchIcon;
  if (workEntry.requestKind === "file-change") return PencilIcon;

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return commandWorkEntryIcon(workEntry);
  }
  if (workEntry.itemType === "file_change" || (workEntry.changedFiles?.length ?? 0) > 0) {
    return PencilIcon;
  }
  if (workEntry.itemType === "web_search") return GlobeIcon;
  if (workEntry.itemType === "image_view") return EyeIcon;
  if (isFileReadToolEntry(workEntry)) return SearchIcon;

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return WrenchIcon;
    case "dynamic_tool_call":
      return HammerIcon;
    case "collab_agent_tool_call":
      return BotIcon;
  }

  // Subagent lifecycle rows (grouped by taskId) get agent identity chrome.
  if (workEntry.taskId) {
    return BotIcon;
  }

  return workToneIcon(workEntry.tone);
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

/**
 * Joins heading and preview with the same middot the rest of a row's clauses
 * use, dropping the preview when it just repeats the heading so a row never
 * reads "Read · Read".
 */
function combineWorkEntryDisplayText(heading: string, preview: string | null): string {
  if (!preview) {
    return heading;
  }
  return normalizeToolTextForComparison(heading) === normalizeToolTextForComparison(preview)
    ? heading
    : `${heading} · ${preview}`;
}

function isFileEditWorkEntry(workEntry: TimelineWorkEntry): boolean {
  return (
    workEntry.requestKind === "file-change" ||
    workEntry.itemType === "file_change" ||
    (workEntry.changedFiles?.length ?? 0) > 0
  );
}

type ChangedFileStatInput = {
  additions?: number | undefined;
  deletions?: number | undefined;
};

function fileStatHasValues(file: ChangedFileStatInput): boolean {
  return typeof file.additions === "number" || typeof file.deletions === "number";
}

function summarizeChangedFileStats(
  files: ReadonlyArray<ChangedFileStatInput> | undefined,
): { additions: number; deletions: number } | null {
  if (!files?.some(fileStatHasValues)) {
    return null;
  }
  return files.reduce<{ additions: number; deletions: number }>(
    (stat, file) => ({
      additions: stat.additions + (file.additions ?? 0),
      deletions: stat.deletions + (file.deletions ?? 0),
    }),
    { additions: 0, deletions: 0 },
  );
}

function basenameFromPath(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  const segments = normalized.split("/");
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment) {
      return segment;
    }
  }
  return filePath;
}

function CompactDiffStatLabel(props: { additions: number; deletions: number }) {
  return (
    <>
      <span className="text-success">+{props.additions}</span>
      <span className="ml-1 text-destructive">-{props.deletions}</span>
    </>
  );
}

/**
 * Inner content of a tool-call row: leading glyph, then one truncating line of
 * "Heading · target · Status · 1s elapsed". Both tones brighten together on row
 * hover/focus so the row reads as a single unit rather than a fill highlight.
 * Callers own the interactive wrapper and supply the `group/tool-row` class.
 */
const WorkEntryRowContent = memo(function WorkEntryRowContent(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
}) {
  const { workEntry, workspaceRoot } = props;
  const isErrored = isErroredWorkEntry(workEntry);
  const EntryIcon = workEntryIcon(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const preview = workEntryPreview(workEntry, workspaceRoot);
  const rawCommand = workEntryRawCommand(workEntry);
  // A command row always has something to say after the verb, falling back to
  // the humanized target when there is no preview of its own.
  const displayText = combineWorkEntryDisplayText(
    heading,
    preview ?? (rawCommand ? deriveReadableCommandDisplay(rawCommand).target : null),
  );
  const metaText = workEntryActivityMeta(workEntry);
  const fullText = metaText ? `${displayText} · ${metaText}` : displayText;

  return (
    <>
      <span
        className={cn(
          "flex size-5 items-center justify-center",
          WORK_ROW_TONE_CLASS_NAME,
          isErrored &&
            "text-destructive-foreground group-hover/tool-row:text-destructive-foreground group-focus-visible/tool-row:text-destructive-foreground",
        )}
        data-work-entry-icon="true"
      >
        <EntryIcon className="size-3.5" />
      </span>
      <Tooltip>
        <TooltipTrigger
          className="block min-w-0 w-full text-left"
          aria-label={fullText}
          render={
            <div className="min-w-0 overflow-hidden">
              <p
                className={cn("truncate text-[12px] leading-5", WORK_ROW_TONE_CLASS_NAME)}
                data-work-entry-display-text="true"
              >
                <span>{displayText}</span>
                {metaText ? <span data-work-entry-meta="true"> · {metaText}</span> : null}
              </p>
            </div>
          }
        />
        <TooltipPopup side="top" align="start" className="max-w-[min(56rem,calc(100vw-2rem))]">
          <WorkEntryTooltipContent displayText={fullText} rawCommand={rawCommand} />
        </TooltipPopup>
      </Tooltip>
    </>
  );
});

/**
 * Hover card for a tool row. A command row shows the summary above its full raw
 * call, since the row itself only has space for the humanized form.
 */
function WorkEntryTooltipContent(props: { displayText: string; rawCommand: string | null }) {
  if (!props.rawCommand) {
    return (
      <p className="whitespace-pre-wrap wrap-break-word text-xs leading-5">{props.displayText}</p>
    );
  }
  return (
    <div className="space-y-2 text-xs leading-5">
      <div className="space-y-0.5">
        <div className="text-muted-foreground/70">Summary</div>
        <div className="whitespace-pre-wrap wrap-break-word">{props.displayText}</div>
      </div>
      <div className="space-y-0.5">
        <div className="text-muted-foreground/70">Raw call</div>
        <code className="block whitespace-pre-wrap wrap-break-word font-mono text-[11px] text-foreground/92">
          {props.rawCommand}
        </code>
      </div>
    </div>
  );
}

const FileEditWorkEntryRow = memo(function FileEditWorkEntryRow(props: {
  isEditing: boolean;
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
}) {
  const { isEditing, workEntry, workspaceRoot } = props;
  const changedFiles = workEntry.changedFiles ?? [];
  const statsByPath = new Map(
    (workEntry.changedFileStats ?? []).map((file) => [file.path, file] as const),
  );
  const visibleFiles = changedFiles.slice(0, 3);
  const hiddenCount = Math.max(0, changedFiles.length - visibleFiles.length);
  const firstFile = changedFiles[0];
  const firstDisplayPath = firstFile ? formatWorkspaceRelativePath(firstFile, workspaceRoot) : null;
  const primaryLabel =
    changedFiles.length === 1 && firstDisplayPath
      ? `${workEntry.completed ? "Edited" : "Editing"} ${firstDisplayPath}`
      : `${workEntry.completed ? "Edited" : "Editing"} ${changedFiles.length} files`;
  const firstFileStat = firstFile ? statsByPath.get(firstFile) : undefined;
  const stat = workEntry.completed
    ? changedFiles.length === 1 && firstFile
      ? summarizeChangedFileStats(firstFileStat ? [firstFileStat] : undefined)
      : summarizeChangedFileStats(workEntry.changedFileStats)
    : null;

  return (
    <div
      className={cn(
        COMPACT_WORK_ROW_CLASS_NAME,
        "chat-file-edit-row",
        changedFiles.length > 1 && "items-start py-1.5",
      )}
      data-tool-entry-row="true"
      data-tool-entry-kind="file-edit"
      data-file-edit-work-row="true"
      data-file-edit-work-state={workEntry.completed ? "completed" : "editing"}
    >
      <span
        className={cn(
          "flex size-5 items-center justify-center",
          WORK_ROW_TONE_CLASS_NAME,
          changedFiles.length > 1 && "mt-0.5",
        )}
        data-work-entry-icon="true"
      >
        <PencilIcon className="size-3.5" />
      </span>
      <div className="min-w-0">
        <p
          className={cn(
            "chat-file-edit-text truncate text-[12px] leading-5",
            WORK_ROW_TONE_CLASS_NAME,
            isEditing && "chat-file-edit-text--active",
          )}
          title={primaryLabel}
        >
          {primaryLabel}
        </p>
        {changedFiles.length > 1 && (
          <div className="mt-0.5 flex min-w-0 flex-nowrap gap-1 overflow-hidden">
            {visibleFiles.map((filePath) => {
              const displayPath = formatWorkspaceRelativePath(filePath, workspaceRoot);
              const rawFileStat = statsByPath.get(filePath);
              const fileStat = summarizeChangedFileStats(rawFileStat ? [rawFileStat] : undefined);
              return (
                <span
                  key={`${workEntry.id}:edit-chip:${filePath}`}
                  className="inline-flex min-w-0 max-w-[15rem] items-center gap-1 rounded border border-border/45 px-1.5 py-0.5 font-mono text-[9px] leading-3 text-muted-foreground/70"
                  title={displayPath}
                >
                  <span className="truncate">{basenameFromPath(displayPath)}</span>
                  {fileStat && (
                    <span className="shrink-0">
                      <CompactDiffStatLabel
                        additions={fileStat.additions}
                        deletions={fileStat.deletions}
                      />
                    </span>
                  )}
                </span>
              );
            })}
            {hiddenCount > 0 && (
              <span className="shrink-0 px-1 text-[10px] leading-4 text-muted-foreground/55">
                +{hiddenCount}
              </span>
            )}
          </div>
        )}
      </div>
      {stat ? (
        <span className={cn("shrink-0 font-mono text-[10px]", changedFiles.length > 1 && "mt-1")}>
          <CompactDiffStatLabel additions={stat.additions} deletions={stat.deletions} />
        </span>
      ) : (
        <span className="size-5" aria-hidden />
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Expandable wrapper — the row is a disclosure summary with a trailing chevron;
// the panel below carries the Activity card and the command transcript.
// ---------------------------------------------------------------------------

const ANSI_SGR_RE = new RegExp(String.raw`\u001b\[[0-9;]*m`, "g");

function workEntryExpandPanelId(entryId: string): string {
  return `work-entry-panel:${entryId}`;
}

const ExpandableWorkEntryRow = memo(function ExpandableWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
}) {
  const { workEntry, workspaceRoot } = props;
  const { routeThreadKey } = use(TimelineStableCtx);
  const stored = useUiStateStore(
    (store) => store.threadWorkEntryExpandedById[routeThreadKey]?.[workEntry.id],
  );
  const setExpanded = useUiStateStore((store) => store.setThreadWorkEntryExpanded);
  const isOpen = stored ?? false;
  const panelId = workEntryExpandPanelId(workEntry.id);
  const heading = toolWorkEntryHeading(workEntry);
  // The panel animates open/closed via a grid-row transition, so its children
  // must outlive the toggle by the length of the close animation.
  const [keepPanelMounted, setKeepPanelMounted] = useState(isOpen);

  useEffect(() => {
    if (isOpen) {
      setKeepPanelMounted(true);
      return;
    }
    if (!keepPanelMounted) return;
    const cleanup = window.setTimeout(
      () => setKeepPanelMounted(false),
      DISCLOSURE_TRANSITION_MS + DISCLOSURE_CLEANUP_BUFFER_MS,
    );
    return () => window.clearTimeout(cleanup);
  }, [isOpen, keepPanelMounted]);

  const toggle = () => {
    setExpanded(routeThreadKey, workEntry.id, !isOpen);
  };

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggle();
          }
        }}
        data-tool-entry-row="true"
        data-tool-entry-kind="expandable"
        className={cn(
          COMPACT_WORK_ROW_CLASS_NAME,
          "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        )}
      >
        <WorkEntryRowContent workEntry={workEntry} workspaceRoot={workspaceRoot} />
        <span className="flex size-5 items-center justify-center">
          <DisclosureChevron open={isOpen} className={cn("size-3", WORK_ROW_TONE_CLASS_NAME)} />
        </span>
      </div>
      <DisclosureRegion open={isOpen} contentClassName="min-w-0 pl-9">
        {keepPanelMounted ? (
          <WorkEntryExpandedPanel workEntry={workEntry} panelId={panelId} headingLabel={heading} />
        ) : null}
      </DisclosureRegion>
    </div>
  );
});

const WorkEntryExpandedPanel = memo(function WorkEntryExpandedPanel(props: {
  workEntry: TimelineWorkEntry;
  panelId: string;
  headingLabel: string;
}) {
  const { workEntry, panelId, headingLabel } = props;
  const { activeThreadEnvironmentId, markdownCwd, timestampFormat } = use(TimelineStableCtx);
  const inputLine = workEntryRawCommand(workEntry);
  const cleanedOutput = workEntry.output ? workEntry.output.replace(ANSI_SGR_RE, "") : "";
  const hasOutput = cleanedOutput.length > 0;
  // The collapsed row truncates its detail behind a hover tooltip, which taps
  // cannot reach; the panel carries the full text so it stays available.
  const detailText = workEntry.detail?.trim() || null;

  return (
    <div
      id={panelId}
      role="region"
      aria-label={`${headingLabel} details`}
      className="space-y-3 pt-2 pb-1"
    >
      <WorkEntryActivitySection
        workEntry={workEntry}
        detailText={detailText !== inputLine ? detailText : null}
        timestampFormat={timestampFormat}
      />

      {inputLine || hasOutput ? (
        <ChatMarkdown
          text={buildShellTranscriptFence(inputLine, cleanedOutput, workEntry.exitCode)}
          cwd={markdownCwd}
          environmentId={activeThreadEnvironmentId}
          isStreaming={false}
        />
      ) : (
        <p className="text-[11px] italic text-muted-foreground/45">No output was captured.</p>
      )}
    </div>
  );
});

/**
 * Status/timing card for one tool call. Rows are omitted rather than shown
 * empty: `startedAt` only exists once a start event was correlated, so a lone
 * completion reports what it knows and nothing more.
 */
function WorkEntryActivitySection(props: {
  workEntry: TimelineWorkEntry;
  detailText: string | null;
  timestampFormat: TimestampFormat;
}) {
  const { workEntry, detailText, timestampFormat } = props;
  const statusLabel = formatWorkEntryStatusLabel(resolveWorkEntryStatus(workEntry));
  const elapsed = formatWorkEntryElapsed(workEntry);
  const lastActivityAt = workEntry.lastActivityAt ?? workEntry.createdAt;

  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-medium text-muted-foreground/56">Activity</h3>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-lg border border-border/45 bg-background/60 px-3 py-2.5 text-[11px]">
        <dt className="text-muted-foreground/56">Status</dt>
        <dd className="text-foreground/84">{statusLabel}</dd>
        {workEntry.startedAt ? (
          <>
            <dt className="text-muted-foreground/56">Started</dt>
            <dd className="text-foreground/84">
              <time dateTime={workEntry.startedAt} title={workEntry.startedAt}>
                {formatTimestamp(workEntry.startedAt, timestampFormat)}
              </time>
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground/56">Last activity</dt>
        <dd className="text-foreground/84">
          <time dateTime={lastActivityAt} title={lastActivityAt}>
            {formatTimestamp(lastActivityAt, timestampFormat)}
          </time>
        </dd>
        {elapsed ? (
          <>
            <dt className="text-muted-foreground/56">Elapsed</dt>
            <dd className="tabular-nums text-foreground/84">{elapsed}</dd>
          </>
        ) : null}
        {detailText ? (
          <>
            <dt className="text-muted-foreground/56">Detail</dt>
            {/* The collapsed row truncates this and reveals the rest on hover,
                which a touch device cannot do — so the panel carries the full
                text on every tier, not just phone. */}
            <dd data-work-entry-detail="true" className="wrap-break-word text-foreground/84">
              {detailText}
            </dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}

/**
 * Renders the command and its output as one `bash` fence so the shared markdown
 * code block handles syntax highlighting, wrapping, and copy — the transcript
 * gets the same treatment as any other code in a reply.
 */
function buildShellTranscriptFence(
  command: string | null,
  output: string,
  exitCode: number | undefined,
): string {
  const lines: string[] = [];
  if (command) {
    const [first, ...rest] = command.split("\n");
    lines.push(`$ ${first ?? ""}`, ...rest);
  }
  if (output) {
    if (lines.length > 0) lines.push("");
    lines.push(output.replace(/\s+$/, ""));
  }
  if (exitCode !== undefined && exitCode !== 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`Exit code ${exitCode}`);
  }
  // A fence long enough to survive any backtick run inside the captured output.
  const fence = "`".repeat(Math.max(3, longestBacktickRun(lines.join("\n")) + 1));
  return `${fence}bash\n${lines.join("\n")}\n${fence}`;
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  let current = 0;
  for (const char of value) {
    if (char === "`") {
      current += 1;
      longest = Math.max(longest, current);
      continue;
    }
    current = 0;
  }
  return longest;
}
