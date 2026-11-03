import type { TurnId } from "@ryco/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import type { RememberedThreadReadingAnchor } from "@ryco/client-runtime/state/threads";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  rememberThreadReadingAnchor,
  rememberThreadReadingAtEnd,
} from "../../persistence/threadReadingPositions";
import { timelineRowTurnId, type MessagesTimelineRow } from "./MessagesTimeline.logic";

/** Frames the restored row has to hold its place before the list counts as positioned. */
const RESTORE_SETTLED_FRAMES = 2;
/** Frames a restore may take before it stops correcting and leaves the list where it is. */
const RESTORE_MAX_FRAMES = 60;
/** Distance from the remembered spot a restore tolerates (sub-pixel layout). */
const RESTORE_TOLERANCE_PX = 1;

type TimelineListState = ReturnType<LegendListRef["getState"]>;

/**
 * How a thread opened with a remembered row turned out, reported once:
 * - `restored`: the row is being brought back to where it was left; the
 *   thread is away from its end and does not follow live output.
 * - `end`: the row is gone (a fold, history no longer loaded) and was
 *   forgotten; the thread opens at its end and follows it.
 * - `released`: the reader scrolled or jumped first, or a deep link or search
 *   target positions the list; the remembered row is not restored.
 * Live follow turned on first (a send) reports nothing: the end won.
 */
export type ReadingPositionOutcome = "restored" | "end" | "released";

interface RestoreTarget {
  readonly rowId: string;
  readonly index: number;
  readonly offsetWithinRow: number;
}

/** What owns the list's position: a restore waiting for its row, one bringing it back, or nothing. */
type Hold =
  | { readonly kind: "waiting" }
  | { readonly kind: "restoring"; readonly target: RestoreTarget };

const WAITING: Hold = { kind: "waiting" };

function restoringHold(anchor: RememberedThreadReadingAnchor, index: number): Hold {
  return {
    kind: "restoring",
    target: { rowId: anchor.rowId, index, offsetWithinRow: anchor.offsetWithinRow },
  };
}

/**
 * Opens a thread where its reader left it, and remembers where that is.
 *
 * A thread left away from its end reopens with the remembered row at the
 * same distance from the viewport's top. LegendList scrolls to the row from
 * estimated sizes, so the row is then measured in the DOM until it holds its
 * place; meanwhile the list neither pins its end nor shifts content on its own.
 *
 * Rows painted from a cache, or none yet, can still gain the row: the
 * restore waits for the thread's live rows before it calls the row gone,
 * without remembering anything meanwhile. Any scroll input, or a switch to
 * live follow (the pill, a send), ends a restore, waiting or not, at once.
 */
export function useTimelineReadingPosition({
  listRef,
  routeThreadKey,
  rows,
  rowsLive,
  openingAnchor,
  restoreSuppressed,
  liveFollowEnabled,
  watchedTurnIds,
  onResolved,
}: {
  readonly listRef: React.RefObject<LegendListRef | null>;
  readonly routeThreadKey: string;
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
  /** The rows come from the thread's live detail; cached or pending rows may still lack the row. */
  readonly rowsLive: boolean;
  /** Where the thread was left, as the chat view read it when the thread opened. */
  readonly openingAnchor: RememberedThreadReadingAnchor | null;
  /** A deep link or search target positions the list instead. */
  readonly restoreSuppressed: boolean;
  readonly liveFollowEnabled: boolean;
  readonly watchedTurnIds: ReadonlySet<TurnId>;
  readonly onResolved: ((outcome: ReadingPositionOutcome) => void) | undefined;
}) {
  // Decided at mount: LegendList reads its initial scroll on mount only. Live
  // follow already on means the reader chose the end before the list existed.
  const [opening] = useState(() => {
    if (openingAnchor === null || liveFollowEnabled) return null;
    return {
      anchor: openingAnchor,
      indexAtMount: restoreSuppressed
        ? -1
        : rows.findIndex((row) => row.id === openingAnchor.rowId),
    };
  });
  const pendingRef = useRef(opening?.anchor ?? null);
  const [hold, setHoldState] = useState<Hold | null>(() =>
    opening === null
      ? null
      : opening.indexAtMount < 0
        ? WAITING
        : restoringHold(opening.anchor, opening.indexAtMount),
  );
  // Read by scroll handlers and effects, which must see a change at once.
  const holdRef = useRef(hold);
  const setHold = useCallback((next: Hold | null) => {
    holdRef.current = next;
    setHoldState(next);
  }, []);
  // Declared before the effects that call it, so it is current when they run.
  const onResolvedRef = useRef(onResolved);
  useLayoutEffect(() => {
    onResolvedRef.current = onResolved;
  });
  const stopRestoreRef = useRef<((byInput: boolean) => void) | null>(null);

  // Resolves the remembered row once the rows hold it, or once they are live
  // and do not.
  useLayoutEffect(() => {
    const anchor = pendingRef.current;
    if (anchor === null) return;
    if (restoreSuppressed) {
      pendingRef.current = null;
      setHold(null);
      onResolvedRef.current?.("released");
      return;
    }
    const index = rows.findIndex((row) => row.id === anchor.rowId);
    if (index < 0 && !rowsLive) return;
    pendingRef.current = null;
    if (index < 0) {
      rememberThreadReadingAtEnd(routeThreadKey);
      setHold(null);
      onResolvedRef.current?.("end");
      return;
    }
    if (!listRef.current) {
      setHold(null);
      onResolvedRef.current?.("released");
      return;
    }
    // Already restoring when the row was there at mount.
    if (holdRef.current?.kind !== "restoring") setHold(restoringHold(anchor, index));
    onResolvedRef.current?.("restored");
  }, [listRef, restoreSuppressed, routeThreadKey, rows, rowsLive, setHold]);

  // Brings the row back for as long as the hold stands. Unmounting stops it
  // without touching the list, whose ref is detached by then; StrictMode's
  // rehearsed unmount and remount starts it again.
  const restoreTarget = hold?.kind === "restoring" ? hold.target : null;
  useLayoutEffect(() => {
    if (restoreTarget === null) return;
    const list = listRef.current;
    if (!list) {
      setHold(null);
      return;
    }
    const restore = restoreRow(list, restoreTarget, () => setHold(null));
    stopRestoreRef.current = restore.stop;
    return () => {
      if (stopRestoreRef.current === restore.stop) stopRestoreRef.current = null;
      restore.dispose();
    };
  }, [listRef, restoreTarget, setHold]);

  // Ends a waiting restore; `outcome` is what the chat view is told, if anything.
  const abandonPending = useCallback(
    (outcome: ReadingPositionOutcome | null) => {
      if (pendingRef.current === null) return false;
      pendingRef.current = null;
      setHold(null);
      if (outcome !== null) onResolvedRef.current?.(outcome);
      return true;
    },
    [setHold],
  );

  // The pill or a send turns live follow on: the end wins over the restore.
  const previousLiveFollowRef = useRef(liveFollowEnabled);
  useEffect(() => {
    const wasFollowing = previousLiveFollowRef.current;
    previousLiveFollowRef.current = liveFollowEnabled;
    if (!liveFollowEnabled || wasFollowing) return;
    if (!abandonPending(null)) stopRestoreRef.current?.(false);
  }, [abandonPending, liveFollowEnabled]);

  /** Ends a restore, waiting or in progress, because the reader scrolled, clicked or jumped. */
  const cancelRestore = useCallback(() => {
    if (!abandonPending("released")) stopRestoreRef.current?.(true);
  }, [abandonPending]);

  /**
   * Remembers the spot the list shows, from its scroll handler. A list that
   * follows live output, or rests at its end, is remembered at its end.
   * Otherwise the row at the viewport's top is found by its laid-out position
   * and measured in the DOM, which includes the list header and any pending
   * layout adjustment. Nothing is remembered while a restore holds the list:
   * the spot it shows is not the reader's yet.
   */
  const rememberPosition = useCallback(
    (state: TimelineListState | undefined, scrollNode: HTMLElement, isAtEnd: boolean) => {
      if (holdRef.current !== null) return;
      if (liveFollowEnabled || isAtEnd) {
        rememberThreadReadingAtEnd(routeThreadKey);
        return;
      }
      const index = state ? findTopRowIndex(state) : -1;
      if (!state || index < 0) return;
      const row = state.data[index] as MessagesTimelineRow | undefined;
      const element = state.elementAtIndex(index);
      if (typeof row?.id !== "string" || !(element instanceof HTMLElement)) return;
      const offsetWithinRow = Math.round(
        scrollNode.getBoundingClientRect().top - element.getBoundingClientRect().top,
      );
      const turnId = timelineRowTurnId(row);
      rememberThreadReadingAnchor(
        routeThreadKey,
        {
          rowId: row.id,
          offsetWithinRow,
          ...(turnId !== null && watchedTurnIds.has(turnId) ? { turnId } : {}),
        },
        watchedTurnIds,
      );
    },
    [liveFollowEnabled, routeThreadKey, watchedTurnIds],
  );

  const restoreRowId = restoreTarget?.rowId ?? null;
  // Keeps the restored row mounted while its place is measured.
  const alwaysRender = useMemo(
    () => (restoreRowId === null ? undefined : { keys: [restoreRowId] }),
    [restoreRowId],
  );

  return {
    /** What a restore is doing, if one holds the list: for the view's probes and tests. */
    hold: hold?.kind ?? null,
    /** A restore owns the list's position: scroll reports wait until it lets go. */
    holdRef,
    /** A restore is bringing its row back: the list must not pin its end or shift content. */
    restoring: restoreRowId !== null,
    initialScrollAtEnd: opening === null || opening.indexAtMount < 0,
    alwaysRender,
    cancelRestore,
    rememberPosition,
  };
}

/**
 * Scrolls `target` to its remembered place, then corrects from DOM
 * measurements every frame until it holds still. Calls `onDone` when it lets
 * go, on its own or through `stop`; stopping because of input first
 * supersedes a scroll still in flight, before the browser applies the
 * gesture. `dispose` ends it without `onDone` and without touching the list.
 */
function restoreRow(
  list: LegendListRef,
  target: RestoreTarget,
  onDone: () => void,
): { readonly stop: (byInput: boolean) => void; readonly dispose: () => void } {
  let done = false;
  let frame: number | null = null;
  let frames = 0;
  let settledFrames = 0;
  const end = () => {
    if (done) return false;
    done = true;
    if (frame !== null) cancelAnimationFrame(frame);
    return true;
  };
  const finish = (byInput: boolean) => {
    if (!end()) return;
    const scrollNode = byInput ? list.getScrollableNode() : null;
    if (scrollNode instanceof HTMLElement) {
      void list.scrollToOffset({ offset: scrollNode.scrollTop, animated: false });
    }
    onDone();
  };
  const reconcile = () => {
    frame = null;
    if (done) return;
    frames += 1;
    const scrollNode = list.getScrollableNode();
    const state = list.getState();
    const index = state.indexByKey(target.rowId);
    const row = index === undefined ? null : state.elementAtIndex(index);
    if (scrollNode instanceof HTMLElement && row instanceof HTMLElement) {
      const offset = Math.max(
        0,
        Math.min(
          scrollNode.scrollTop +
            row.getBoundingClientRect().top -
            scrollNode.getBoundingClientRect().top +
            target.offsetWithinRow,
          scrollNode.scrollHeight - scrollNode.clientHeight,
        ),
      );
      if (Math.abs(scrollNode.scrollTop - offset) > RESTORE_TOLERANCE_PX) {
        settledFrames = 0;
        void list.scrollToOffset({ offset, animated: false });
      } else if (++settledFrames >= RESTORE_SETTLED_FRAMES) {
        finish(false);
        return;
      }
    }
    if (frames >= RESTORE_MAX_FRAMES) {
      finish(false);
      return;
    }
    frame = requestAnimationFrame(reconcile);
  };
  void Promise.resolve(
    list.scrollToIndex({
      index: target.index,
      animated: false,
      viewPosition: 0,
      viewOffset: -target.offsetWithinRow,
    }),
  ).then(() => {
    if (!done) frame = requestAnimationFrame(reconcile);
  });
  return {
    stop: finish,
    dispose: () => {
      end();
    },
  };
}

/**
 * The last row whose laid-out top is at or above the scroll offset: the row at
 * the viewport's top. Searched rather than read from the list's visible range,
 * which can lag a fling. Laid-out positions leave out the list header, so the
 * row found can start up to the header's height below the viewport's top; the
 * DOM measurement then records a negative offset into it.
 */
function findTopRowIndex(state: TimelineListState): number {
  const count = state.data.length;
  const scroll = state.scroll;
  if (count === 0 || !Number.isFinite(scroll)) return -1;
  let low = 0;
  let high = count - 1;
  let found = 0;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const top = state.positionAtIndex(middle);
    if (top === undefined || !Number.isFinite(top)) return -1;
    if (top <= scroll) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}
