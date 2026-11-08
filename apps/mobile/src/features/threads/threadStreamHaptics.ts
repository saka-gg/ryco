import type { TimelineEntry } from "@ryco/client-runtime/state/session";
import { useIsFocused } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useEffect, useRef } from "react";

export interface StreamingMessageMark {
  readonly id: string;
  readonly textLength: number;
}

/** Growth of one reply ticks at most this often, so a fast stream reads as texture, not a buzz. */
const STREAM_HAPTIC_THROTTLE_MS = 320;

/** The newest assistant message still streaming, with how much text it has. */
export function latestStreamingAssistantMessage(
  timeline: ReadonlyArray<TimelineEntry>,
): StreamingMessageMark | null {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];
    if (entry?.kind !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant" && message.streaming) {
      return { id: message.id, textLength: message.text.length };
    }
  }
  return null;
}

/**
 * A new stream always ticks; growth of the same stream ticks at most once per
 * throttle window.
 */
export function shouldTickStreamHaptic(input: {
  readonly previous: StreamingMessageMark | null;
  readonly latest: StreamingMessageMark | null;
  readonly lastTickAt: number;
  readonly now: number;
}): boolean {
  const { previous, latest } = input;
  if (latest === null) return false;
  if (previous?.id !== latest.id) return true;
  if (latest.textLength <= previous.textLength) return false;
  return input.now - input.lastTickAt >= STREAM_HAPTIC_THROTTLE_MS;
}

/**
 * Ticks a light selection haptic as the open thread's reply streams in. The
 * first timeline it sees only seeds the mark, so opening a thread mid-stream
 * is silent; turning the setting off stops it at once. A thread screen covered
 * by another (a sheet, a pushed thread) stays silent.
 */
export function useThreadStreamHaptics(
  threadKey: string,
  timeline: ReadonlyArray<TimelineEntry> | undefined,
  enabled: boolean,
): void {
  const focused = useIsFocused();
  const state = useRef<{
    threadKey: string;
    seeded: boolean;
    previous: StreamingMessageMark | null;
    lastTickAt: number;
  }>({ threadKey, seeded: false, previous: null, lastTickAt: 0 });
  // Compares each new timeline with the last one and ticks when the reply grew.
  useEffect(() => {
    if (state.current.threadKey !== threadKey) {
      // Another thread on the same screen seeds afresh: opening it mid-stream is silent.
      state.current = { threadKey, seeded: false, previous: null, lastTickAt: 0 };
    }
    if (timeline === undefined) return;
    const mark = state.current;
    const latest = latestStreamingAssistantMessage(timeline);
    const now = Date.now();
    const tick =
      enabled &&
      focused &&
      mark.seeded &&
      shouldTickStreamHaptic({ previous: mark.previous, latest, lastTickAt: mark.lastTickAt, now });
    mark.seeded = true;
    mark.previous = latest;
    if (!tick) return;
    mark.lastTickAt = now;
    void Haptics.selectionAsync();
  }, [enabled, focused, threadKey, timeline]);
}
