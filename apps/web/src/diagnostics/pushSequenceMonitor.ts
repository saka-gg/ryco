import type { EnvironmentId } from "@ryco/contracts";
import { create } from "zustand";

/**
 * Client-side detector for gaps in the per-environment orchestration push
 * stream. The server emits monotonically increasing `sequence` numbers for
 * every shell event within a subscription; a received sequence that skips
 * ahead of the expected next value indicates dropped/out-of-order delivery
 * that the recovery path must heal. We surface these counts in the
 * Diagnostics page so operators can spot unhealthy connections.
 */

export interface PushSequenceGap {
  readonly expectedSequence: number;
  readonly receivedSequence: number;
  readonly detectedAt: string;
}

export interface PushSequenceEnvironmentState {
  readonly lastSnapshotSequence: number | null;
  readonly lastEventSequence: number | null;
  readonly highestSequence: number | null;
  readonly eventCount: number;
  readonly snapshotCount: number;
  readonly gapCount: number;
  readonly lastGap: PushSequenceGap | null;
  readonly updatedAt: string | null;
}

interface PushSequenceMonitorState {
  readonly byEnvironment: Record<EnvironmentId, PushSequenceEnvironmentState>;
  readonly recordSnapshot: (environmentId: EnvironmentId, snapshotSequence: number) => void;
  readonly recordEvent: (environmentId: EnvironmentId, sequence: number) => void;
}

const DEFAULT_ENVIRONMENT_STATE: PushSequenceEnvironmentState = Object.freeze({
  lastSnapshotSequence: null,
  lastEventSequence: null,
  highestSequence: null,
  eventCount: 0,
  snapshotCount: 0,
  gapCount: 0,
  lastGap: null,
  updatedAt: null,
});

function nowIso(): string {
  return new Date().toISOString();
}

/** Pure reducer: fold a snapshot sequence into the per-environment state. */
export function reduceSnapshot(
  previous: PushSequenceEnvironmentState | undefined,
  snapshotSequence: number,
  detectedAt: string,
): PushSequenceEnvironmentState {
  const prev = previous ?? DEFAULT_ENVIRONMENT_STATE;
  const highestSequence =
    prev.highestSequence === null
      ? snapshotSequence
      : Math.max(prev.highestSequence, snapshotSequence);
  return {
    ...prev,
    lastSnapshotSequence: snapshotSequence,
    highestSequence,
    snapshotCount: prev.snapshotCount + 1,
    updatedAt: detectedAt,
  };
}

/** Pure reducer: fold an event sequence into the per-environment state. */
export function reduceEvent(
  previous: PushSequenceEnvironmentState | undefined,
  sequence: number,
  detectedAt: string,
): PushSequenceEnvironmentState {
  const prev = previous ?? DEFAULT_ENVIRONMENT_STATE;
  const baseline = prev.highestSequence;
  let gapCount = prev.gapCount;
  let lastGap = prev.lastGap;

  if (baseline !== null && sequence > baseline + 1) {
    gapCount += 1;
    lastGap = {
      expectedSequence: baseline + 1,
      receivedSequence: sequence,
      detectedAt,
    };
  }

  const highestSequence = baseline === null ? sequence : Math.max(baseline, sequence);

  return {
    ...prev,
    lastEventSequence: sequence,
    highestSequence,
    eventCount: prev.eventCount + 1,
    gapCount,
    lastGap,
    updatedAt: detectedAt,
  };
}

export const usePushSequenceMonitor = create<PushSequenceMonitorState>()((set) => ({
  byEnvironment: {},
  recordSnapshot: (environmentId, snapshotSequence) =>
    set((state) => ({
      byEnvironment: {
        ...state.byEnvironment,
        [environmentId]: reduceSnapshot(
          state.byEnvironment[environmentId],
          snapshotSequence,
          nowIso(),
        ),
      },
    })),
  recordEvent: (environmentId, sequence) =>
    set((state) => ({
      byEnvironment: {
        ...state.byEnvironment,
        [environmentId]: reduceEvent(state.byEnvironment[environmentId], sequence, nowIso()),
      },
    })),
}));

/**
 * Record a push-stream snapshot. Safe to call from hot connection paths:
 * never throws so a diagnostics failure can't break stream delivery.
 */
export function recordPushSequenceSnapshot(
  environmentId: EnvironmentId,
  snapshotSequence: number,
): void {
  try {
    usePushSequenceMonitor.getState().recordSnapshot(environmentId, snapshotSequence);
  } catch {
    // Diagnostics is best-effort; never disturb stream processing.
  }
}

/**
 * Record a push-stream event. Safe to call from hot connection paths:
 * never throws so a diagnostics failure can't break stream delivery.
 */
export function recordPushSequenceEvent(environmentId: EnvironmentId, sequence: number): void {
  try {
    usePushSequenceMonitor.getState().recordEvent(environmentId, sequence);
  } catch {
    // Diagnostics is best-effort; never disturb stream processing.
  }
}
