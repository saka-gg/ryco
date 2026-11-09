import { useEffect, useRef, useState } from "react";
import type { NativeScrollEvent } from "react-native";
import {
  ReduceMotion,
  useSharedValue,
  withSpring,
  type SharedValue,
} from "react-native-reanimated";

import {
  INITIAL_COMPOSER_SHRINK,
  nextComposerShrink,
  type ComposerShrinkState,
} from "./composerShrinkModel";

// The composer's own spring: critically damped, so the feed it hands its room to never
// bounces. The bubble springs in on a softer one with a little overshoot.
const SHRINK_SPRING = {
  damping: 26,
  stiffness: 280,
  mass: 0.9,
  overshootClamping: true,
  reduceMotion: ReduceMotion.System,
} as const;
const BUBBLE_SPRING = {
  damping: 15,
  stiffness: 260,
  mass: 0.8,
  reduceMotion: ReduceMotion.System,
} as const;

/** What the composer reads to shrink itself, and reports back. */
export interface ComposerShrinkBinding {
  /** 0 = the full composer, 1 = shrunk into the bubble. */
  readonly progress: SharedValue<number>;
  readonly collapsed: boolean;
  /** The composer's full height, measured: what the feed gains while it is shrunk. */
  readonly height: SharedValue<number>;
  /** The reader writes, dictates or picks a command: the composer must stay. */
  readonly onHeldChange: (held: boolean) => void;
}

export interface ComposerShrink {
  readonly binding: ComposerShrinkBinding;
  /** 0 → 1 with overshoot, for the bubble and what moves aside for it. */
  readonly bubbleProgress: SharedValue<number>;
  readonly collapsed: boolean;
  /** Feed scroll events; the reader's own scrolling is what shrinks it. */
  readonly onScroll: (event: NativeScrollEvent, userScrolling: boolean) => void;
  readonly expand: () => void;
}

/**
 * The chat composer's shrink-away while the reader scrolls back (the composer then gives the
 * feed its room and waits as a "Message" bubble), keyed per chat so another chat starts with
 * the full composer.
 */
export function useComposerShrink(chatKey: string): ComposerShrink {
  const progress = useSharedValue(0);
  const bubbleProgress = useSharedValue(0);
  const height = useSharedValue(0);
  // Keyed by chat: another chat starts with the full composer and its own scroll history.
  const state = useRef<{ key: string; value: ComposerShrinkState }>({
    key: chatKey,
    value: INITIAL_COMPOSER_SHRINK,
  });
  const [collapsedFor, setCollapsedFor] = useState<string | null>(null);
  const [held, setHeld] = useState(false);
  const collapsed = collapsedFor === chatKey && !held;
  const current = () =>
    state.current.key === chatKey
      ? state.current.value
      : (state.current = { key: chatKey, value: INITIAL_COMPOSER_SHRINK }).value;
  const write = (value: ComposerShrinkState) => {
    state.current = { key: chatKey, value };
  };
  const onHeldChange = (next: boolean) => {
    setHeld(next);
    // Writing brings it back for good: the shrink waits for the next scroll back up.
    if (next) {
      write({ ...current(), collapsed: false });
      setCollapsedFor(null);
    }
  };

  useEffect(() => {
    progress.set(withSpring(collapsed ? 1 : 0, SHRINK_SPRING));
    bubbleProgress.set(withSpring(collapsed ? 1 : 0, BUBBLE_SPRING));
  }, [bubbleProgress, collapsed, progress]);

  const onScroll = (event: NativeScrollEvent, userScrolling: boolean) => {
    const previous = current();
    const next = nextComposerShrink(previous, {
      offsetY: event.contentOffset.y,
      viewportHeight: event.layoutMeasurement.height,
      contentHeight: event.contentSize.height,
      userScrolling: userScrolling && !held,
      composerHeight: height.get(),
    });
    write(next);
    if (next.collapsed !== previous.collapsed) setCollapsedFor(next.collapsed ? chatKey : null);
  };
  const expand = () => {
    write({ ...current(), collapsed: false });
    setCollapsedFor(null);
  };

  return {
    binding: { progress, collapsed, height, onHeldChange },
    bubbleProgress,
    collapsed,
    onScroll,
    expand,
  };
}
