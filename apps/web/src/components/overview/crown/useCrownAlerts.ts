import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createTurnCompletionTracker } from "~/lib/turnCompletion.logic";

import { useEvent } from "../../../hooks/useEvent";
import {
  diffCrownSnapshots,
  mergeCrownBaseline,
  type CrownEvent,
  type CrownSnapshot,
} from "./crownAlerts.logic";
import {
  EMPTY_CROWN_ALERT_QUEUE,
  advanceCrownAlert,
  clearCrownAlerts,
  crownAlertDwellMs,
  enqueueCrownAlerts,
  type CrownAlertQueueState,
} from "./crownAlertQueue.logic";
import { CROWN_GIT_ACTION_SUPPRESS_MS } from "./crownLayout";
import { CROWN_RAIL_ITEMS, type CrownRailKey, type CrownTone } from "./crownSections";

/** Per-icon ping: `n` bumps on every event, so a keyed ring element replays its animation. */
export interface CrownPing {
  readonly n: number;
  readonly tone: CrownTone;
}

export type CrownPings = Readonly<Record<CrownRailKey, CrownPing>>;

export interface CrownAlerts {
  /** The alert the crown shows, or null for the face. */
  readonly current: CrownEvent | null;
  /** Waiting alerts, shown as "+N" on the face. */
  readonly queuedCount: number;
  readonly pings: CrownPings;
  /** Drop the shown and waiting alerts. */
  readonly clear: () => void;
}

const INITIAL_PINGS = Object.fromEntries(
  CROWN_RAIL_ITEMS.map((item) => [item.key, { n: 0, tone: "neutral" }]),
) as Record<CrownRailKey, CrownPing>;

/**
 * Starts a timeout that only counts down while the document is visible, so an
 * alert is never missed behind a background tab. Returns a cancel function.
 */
export function startVisibleTimeout(durationMs: number, onExpire: () => void): () => void {
  let remainingMs = durationMs;
  let startedAtMs: number | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const pause = () => {
    if (startedAtMs === null) return;
    remainingMs = Math.max(0, remainingMs - (Date.now() - startedAtMs));
    startedAtMs = null;
    if (timeoutId !== null) clearTimeout(timeoutId);
    timeoutId = null;
  };
  const resume = () => {
    if (startedAtMs !== null) return;
    startedAtMs = Date.now();
    timeoutId = setTimeout(() => {
      timeoutId = null;
      document.removeEventListener("visibilitychange", sync);
      onExpire();
    }, remainingMs);
  };
  const sync = () => (document.hidden ? pause() : resume());

  document.addEventListener("visibilitychange", sync);
  sync();
  return () => {
    document.removeEventListener("visibilitychange", sync);
    if (timeoutId !== null) clearTimeout(timeoutId);
  };
}

/**
 * Turns overview snapshots into crown alerts and rail pings: diffs each new
 * snapshot against the last baseline, feeds its turn to the shared
 * turn-completion tracker, queues loud events and walks the queue on the
 * prototype's dwell timer.
 */
export function useCrownAlerts(input: {
  readonly snapshot: CrownSnapshot;
  readonly cardOpen: boolean;
  readonly userGitActionActive: boolean;
  /** Holds the shown alert while the user is on it (e.g. its View button has focus). */
  readonly paused: boolean;
}): CrownAlerts {
  const { snapshot, cardOpen, userGitActionActive, paused } = input;
  const baselineRef = useRef<CrownSnapshot | null>(null);
  const turnTrackerRef = useRef(createTurnCompletionTracker());
  const suppressGitUntilRef = useRef(userGitActionActive ? Infinity : 0);
  const [queueState, setQueueState] = useState<CrownAlertQueueState>(EMPTY_CROWN_ALERT_QUEUE);
  const [pings, setPings] = useState<CrownPings>(INITIAL_PINGS);

  // Declared before the diff effect so a snapshot landing in the same commit sees the window.
  const gitActionWasActiveRef = useRef(userGitActionActive);
  useEffect(() => {
    if (userGitActionActive) suppressGitUntilRef.current = Infinity;
    else if (gitActionWasActiveRef.current) {
      suppressGitUntilRef.current = Date.now() + CROWN_GIT_ACTION_SUPPRESS_MS;
    }
    gitActionWasActiveRef.current = userGitActionActive;
  }, [userGitActionActive]);

  // Opening the card drops the queue (adjusted during render, React's "previous prop" pattern).
  const [cardWasOpen, setCardWasOpen] = useState(cardOpen);
  if (cardOpen !== cardWasOpen) {
    setCardWasOpen(cardOpen);
    if (cardOpen) setQueueState(clearCrownAlerts);
  }

  const applySnapshot = useEvent((next: CrownSnapshot) => {
    const prev = baselineRef.current;
    const tracker = turnTrackerRef.current;
    // A new thread or checkout re-baselines silently, its turns included.
    if (prev && prev.scopeKey !== next.scopeKey) tracker.reset();
    const turnOutcome = next.turn
      ? tracker.observe({
          turnId: next.turn.turnId,
          running: next.turn.running,
          settled: next.turn.settled,
          completedAt: next.turn.completedAt,
          state: next.turn.state,
        })
      : null;
    const events = diffCrownSnapshots(prev, next, {
      nowMs: Date.now(),
      suppressGitUntilMs: suppressGitUntilRef.current,
      turnOutcome,
    });
    baselineRef.current = mergeCrownBaseline(prev, next);
    if (events.length === 0) return;
    setPings((current) => {
      const bumped = { ...current };
      for (const event of events) {
        // Branch events also light the Push icon, as in the prototype's syncRailIcons.
        const keys: CrownRailKey[] =
          event.kind === "branch" ? [event.railKey, "ship"] : [event.railKey];
        for (const key of keys) bumped[key] = { n: bumped[key].n + 1, tone: event.tone };
      }
      return bumped;
    });
    setQueueState((current) => enqueueCrownAlerts(current, events, { cardOpen }));
  });

  // Parents rebuild the snapshot every render; diff only when its value changes.
  const snapshotKey = useMemo(() => JSON.stringify(snapshot), [snapshot]);
  const stableSnapshot = useMemo(() => JSON.parse(snapshotKey) as CrownSnapshot, [snapshotKey]);
  useEffect(() => {
    applySnapshot(stableSnapshot);
  }, [stableSnapshot, applySnapshot]);

  // The dwell is fixed when an alert appears (prototype `Crown.next`), not when more queue up.
  const currentId = queueState.current?.id ?? null;
  const dwellMs = crownAlertDwellMs(queueState);
  const dwellRef = useRef(dwellMs);
  useEffect(() => {
    dwellRef.current = dwellMs;
  });
  // A pause holds the alert; the dwell starts over once the user moves on.
  useEffect(() => {
    if (currentId === null || paused) return;
    return startVisibleTimeout(dwellRef.current, () => setQueueState(advanceCrownAlert));
  }, [currentId, paused]);

  const clear = useCallback(() => setQueueState(clearCrownAlerts), []);

  return {
    current: queueState.current,
    queuedCount: queueState.queue.length,
    pings,
    clear,
  };
}
