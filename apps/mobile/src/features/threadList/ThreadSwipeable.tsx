import { MenuView, type MenuAction, type NativeActionEvent } from "@react-native-menu/menu";
import type { SFSymbol } from "expo-symbols";
import * as Haptics from "expo-haptics";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  ColorValue,
  NativeScrollEvent,
  NativeSyntheticEvent,
  StyleProp,
  ViewStyle,
} from "react-native";
import { Pressable, View } from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated, {
  cancelAnimation,
  Easing,
  Extrapolation,
  ReduceMotion,
  interpolate,
  runOnJS,
  runOnUI,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { registerThreadDismissal } from "./threadDismissal";
import {
  SWIPE_ACTION_CIRCLE_SIZE,
  SWIPE_ACTION_ICON_SIZE,
  SWIPE_ACTION_ITEM_WIDTH,
  SWIPE_OPEN_THRESHOLD_SHARE,
  THREAD_SWIPE_SPRING,
  armedSwipeSide,
  fullSwipeThreshold,
  swipeActionEntryRange,
  swipeActionsWidth,
  type SwipeSide,
} from "./threadSwipeModel";

export type ThreadSwipeActionTone = "primary" | "secondary" | "accent";

export interface ThreadSwipeAction {
  readonly accessibilityLabel: string;
  readonly icon: SFSymbol;
  readonly label: string;
  readonly tone: ThreadSwipeActionTone;
  /** A button that opens a menu (Snooze's presets) instead of acting at once. */
  readonly menu?: {
    readonly actions: MenuAction[];
    readonly onPressAction: (event: string) => void;
    readonly title?: string;
  };
  readonly onPress: () => void;
}

/** Keep the scroll gate in context so scroll start cannot re-render every row. */
const SwipeableScrollGateContext = createContext(true);
// Swipeable rebuilds its native pan gesture whenever its config changes identity,
// so the props that feed it stay stable across row re-renders.
const FAIL_OFFSET_Y: [number, number] = [-10, 10];

export function SwipeableScrollGateProvider(props: {
  readonly enabled: boolean;
  readonly children: ReactNode;
}) {
  return (
    <SwipeableScrollGateContext value={props.enabled}>{props.children}</SwipeableScrollGateContext>
  );
}

/** Trackpads can start pans mid-momentum, bypassing failOffsetY; disable swipes during vertical scrolls. */
export function useSwipeableScrollGate(options?: {
  readonly onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
}) {
  const [gateActive, setGateActive] = useState(false);
  const gateActiveRef = useRef(false);
  const draggingRef = useRef(false);
  const dragStartYRef = useRef(0);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const externalOnScroll = options?.onScroll;

  const update = useCallback((next: boolean) => {
    if (gateActiveRef.current !== next) {
      gateActiveRef.current = next;
      setGateActive(next);
    }
  }, []);
  const clearSettle = useCallback(() => {
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);
  // Clears the settle timer on unmount.
  useEffect(() => clearSettle, [clearSettle]);

  const onScrollBeginDrag = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      draggingRef.current = true;
      dragStartYRef.current = event.nativeEvent.contentOffset.y;
      clearSettle();
    },
    [clearSettle],
  );
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (
        draggingRef.current &&
        !gateActiveRef.current &&
        Math.abs(event.nativeEvent.contentOffset.y - dragStartYRef.current) > 4
      ) {
        update(true);
      }
      externalOnScroll?.(event);
    },
    [externalOnScroll, update],
  );
  const onScrollEndDrag = useCallback(() => {
    draggingRef.current = false;
    clearSettle();
    settleTimerRef.current = setTimeout(() => update(false), 160);
  }, [clearSettle, update]);
  const onMomentumScrollBegin = useCallback(() => clearSettle(), [clearSettle]);
  const onMomentumScrollEnd = useCallback(() => update(false), [update]);

  return {
    swipeEnabled: !gateActive,
    scrollGateHandlers: {
      onScroll,
      onScrollBeginDrag,
      onScrollEndDrag,
      onMomentumScrollBegin,
      onMomentumScrollEnd,
    },
  };
}

interface ThreadSwipeableProps {
  /** Behind the revealed actions: the list's own background. */
  readonly backgroundColor: ColorValue;
  readonly children: ReactNode;
  readonly containerStyle?: StyleProp<ViewStyle>;
  readonly enabled?: boolean;
  readonly fullSwipeWidth: number;
  /** Revealed by swiping right; a full swipe runs it (Pin / Unpin). */
  readonly leadingAction: ThreadSwipeAction | null;
  /** The inner trailing action; a full swipe left runs it (Archive). */
  readonly primaryAction: ThreadSwipeAction | null;
  /** The outer trailing action (Snooze's menu); never runs on a full swipe. */
  readonly secondaryAction: ThreadSwipeAction | null;
  readonly threadKey: string;
  /** Changes when the thread moves elsewhere in the list, so a dismissed row comes back. */
  readonly resetKey?: string;
}

const DISMISS_TIMING = {
  duration: 220,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
};

/**
 * One thread row with its swipe actions: swipe left for the trailing pair
 * (a full swipe runs the primary), right for the leading action. Rows that a
 * command removes from the list animate out first (`withThreadDismissal`).
 */
export function ThreadSwipeable(props: ThreadSwipeableProps) {
  const swipeableRef = useRef<SwipeableMethods | null>(null);
  const trailingCount = (props.primaryAction ? 1 : 0) + (props.secondaryAction ? 1 : 0);
  const trailingWidth = swipeActionsWidth(trailingCount);
  const trailingThreshold = props.primaryAction
    ? fullSwipeThreshold(trailingCount, props.fullSwipeWidth)
    : null;
  const leadingThreshold = props.leadingAction ? fullSwipeThreshold(1, props.fullSwipeWidth) : null;
  const gateEnabled = use(SwipeableScrollGateContext);
  const mountedRef = useRef(true);
  const armedRef = useRef<SwipeSide | null>(null);
  const dismissalRef = useRef<{ finished: Promise<void>; restore: () => void } | null>(null);
  const pendingDismissRef = useRef<{ id: number; resolve: () => void } | null>(null);
  const dismissalIdRef = useRef(0);
  const activeTranslationRef = useRef<SharedValue<number> | null>(null);
  const content = useMemo(
    () => ({ resetKey: props.resetKey, threadKey: props.threadKey }),
    [props.resetKey, props.threadKey],
  );
  const contentRef = useRef(content);
  const [isDismissing, setIsDismissing] = useState(false);
  const dismissing = useSharedValue(false);
  const rowHeight = useSharedValue(0);
  const rowWidth = useSharedValue(props.fullSwipeWidth);
  const collapse = useSharedValue(0);
  const fallbackTranslation = useSharedValue(0);
  const actionOpacity = useSharedValue(1);
  const { primaryAction, leadingAction } = props;

  const restoreRow = useCallback(() => {
    if (!mountedRef.current) return;
    dismissalRef.current = null;
    // RN-to-UI jobs run in order, so this also resets a queued dismissal.
    runOnUI((methods: SwipeableMethods | null) => {
      "worklet";
      methods?.reset();
      // reset() leaves tap-to-close enabled; close() clears it.
      methods?.close();
      fallbackTranslation.set(0);
      collapse.set(0);
      actionOpacity.set(1);
      dismissing.set(false);
    })(swipeableRef.current);
    setIsDismissing(false);
  }, [actionOpacity, collapse, dismissing, fallbackTranslation]);

  const finishDismiss = useCallback((id?: number) => {
    const pending = pendingDismissRef.current;
    if (!pending || (id !== undefined && pending.id !== id)) return;
    pendingDismissRef.current = null;
    pending.resolve();
  }, []);

  // Cancels the row's animations and settles a pending dismissal on unmount.
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelAnimation(collapse);
      cancelAnimation(actionOpacity);
      cancelAnimation(fallbackTranslation);
      if (activeTranslationRef.current) cancelAnimation(activeTranslationRef.current);
      finishDismiss();
    };
  }, [actionOpacity, collapse, fallbackTranslation, finishDismiss]);

  // The list recycles rows: reset in place so the child views stay mounted.
  useLayoutEffect(() => {
    if (contentRef.current === content) return;
    contentRef.current = content;
    armedRef.current = null;
    finishDismiss();
    restoreRow();
  }, [content, finishDismiss, restoreRow]);

  const dismiss = useCallback(
    (translation: SharedValue<number>, id: number) => {
      "worklet";
      if (dismissing.value) return;
      dismissing.set(true);
      actionOpacity.set(withTiming(0, DISMISS_TIMING));
      translation.set(
        withTiming(Math.min(translation.value, -rowWidth.value), DISMISS_TIMING, (finished) => {
          if (!finished) return;
          collapse.set(
            withTiming(1, { ...DISMISS_TIMING, duration: 180 }, (collapsed) => {
              if (collapsed) runOnJS(finishDismiss)(id);
            }),
          );
        }),
      );
    },
    [actionOpacity, collapse, dismissing, finishDismiss, rowWidth],
  );
  // Registers this row's animated dismissal for `withThreadDismissal`.
  useLayoutEffect(
    () =>
      registerThreadDismissal(props.threadKey, () => {
        if (dismissalRef.current) return dismissalRef.current;
        const id = ++dismissalIdRef.current;
        const finished = new Promise<void>((resolve) => {
          pendingDismissRef.current = { id, resolve };
        });
        setIsDismissing(true);
        runOnUI(dismiss)(activeTranslationRef.current ?? fallbackTranslation, id);
        const dismissal = {
          finished,
          restore: () => {
            if (dismissalRef.current === dismissal) restoreRow();
          },
        };
        dismissalRef.current = dismissal;
        return dismissal;
      }),
    [dismiss, fallbackTranslation, props.threadKey, restoreRow],
  );
  const dismissStyle = useAnimatedStyle(() => ({
    // Native prop updates omit undefined, leaving a collapsed height in place.
    height: dismissing.value ? rowHeight.value * (1 - collapse.value) : "auto",
    pointerEvents: dismissing.value ? "none" : "auto",
    overflow: "hidden",
    transform: [{ translateX: fallbackTranslation.value }],
  }));
  const actionStyle = useAnimatedStyle(() => ({ opacity: actionOpacity.value, height: "100%" }));

  const commitPrimaryAction = useCallback(() => {
    if (!mountedRef.current || contentRef.current !== content || !primaryAction) return;
    primaryAction.onPress();
    if (!pendingDismissRef.current) swipeableRef.current?.close();
  }, [content, primaryAction]);
  const commitLeadingAction = useCallback(() => {
    if (!mountedRef.current || contentRef.current !== content || !leadingAction) return;
    swipeableRef.current?.close();
    leadingAction.onPress();
  }, [content, leadingAction]);

  const handleArmedChange = useCallback(
    (armed: SwipeSide | null) => {
      if (!mountedRef.current || contentRef.current !== content) return;
      armedRef.current = armed;
      if (armed !== null) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    },
    [content],
  );
  // The swipe opens on release; past the full-swipe threshold the release runs the action.
  const handleWillOpen = useCallback(() => {
    if (dismissalRef.current) return;
    const armed = armedRef.current;
    armedRef.current = null;
    if (armed === "trailing") commitPrimaryAction();
    else if (armed === "leading") commitLeadingAction();
  }, [commitLeadingAction, commitPrimaryAction]);

  const backgroundColor = props.backgroundColor;
  const thresholds = useMemo(
    () => ({ leading: leadingThreshold, trailing: trailingThreshold }),
    [leadingThreshold, trailingThreshold],
  );
  const renderRightActions = (
    _progress: SharedValue<number>,
    translation: SharedValue<number>,
    methods: SwipeableMethods,
  ) =>
    trailingCount === 0 ? null : (
      <Animated.View
        ref={() => {
          activeTranslationRef.current = translation;
        }}
        style={actionStyle}
      >
        <SwipeArmedReaction
          translation={translation}
          thresholds={thresholds}
          onArmedChange={handleArmedChange}
        />
        <View
          style={{ backgroundColor, flexDirection: "row", height: "100%", width: trailingWidth }}
        >
          {primaryAction ? (
            <SwipeActionButton
              action={{ ...primaryAction, onPress: commitPrimaryAction }}
              actionsWidth={trailingWidth}
              entryRange={swipeActionEntryRange("inner", trailingCount)}
              fullSwipeThreshold={trailingThreshold}
              side="trailing"
              stretchesOnFullSwipe
              translation={translation}
            />
          ) : null}
          {props.secondaryAction ? (
            <SwipeActionButton
              action={withClose(props.secondaryAction, () => methods.close())}
              actionsWidth={trailingWidth}
              entryRange={swipeActionEntryRange("outer", trailingCount)}
              fullSwipeThreshold={trailingThreshold}
              side="trailing"
              stretchesOnFullSwipe={false}
              translation={translation}
            />
          ) : null}
        </View>
      </Animated.View>
    );
  const renderLeftActions = (_progress: SharedValue<number>, translation: SharedValue<number>) =>
    leadingAction === null ? null : (
      <Animated.View style={actionStyle}>
        {trailingCount === 0 ? (
          <SwipeArmedReaction
            translation={translation}
            thresholds={thresholds}
            onArmedChange={handleArmedChange}
          />
        ) : null}
        <View style={{ backgroundColor, height: "100%", width: SWIPE_ACTION_ITEM_WIDTH }}>
          <SwipeActionButton
            action={{ ...leadingAction, onPress: commitLeadingAction }}
            actionsWidth={SWIPE_ACTION_ITEM_WIDTH}
            entryRange={swipeActionEntryRange("outer", 1)}
            fullSwipeThreshold={leadingThreshold}
            side="leading"
            stretchesOnFullSwipe
            translation={translation}
          />
        </View>
      </Animated.View>
    );
  const childrenContainerStyle = useMemo(() => ({ backgroundColor }), [backgroundColor]);
  const swipeableContainerStyle = useMemo(
    () => [{ backgroundColor }, props.containerStyle],
    [backgroundColor, props.containerStyle],
  );

  return (
    <Animated.View style={dismissStyle}>
      <View
        onLayout={({ nativeEvent: { layout } }) => {
          rowHeight.set(layout.height);
          rowWidth.set(layout.width);
        }}
      >
        <ReanimatedSwipeable
          ref={swipeableRef}
          animationOptions={THREAD_SWIPE_SPRING}
          childrenContainerStyle={childrenContainerStyle}
          containerStyle={swipeableContainerStyle}
          dragOffsetFromRightEdge={8}
          dragOffsetFromLeftEdge={8}
          enabled={!isDismissing && props.enabled !== false && gateEnabled}
          enableTrackpadTwoFingerGesture
          // Reject vertical pans (patched failOffsetY): list scrolls never open a row.
          failOffsetY={FAIL_OFFSET_Y}
          friction={1}
          onSwipeableWillOpen={handleWillOpen}
          overshootFriction={1}
          overshootLeft={leadingAction !== null}
          overshootRight={primaryAction !== null}
          renderLeftActions={leadingAction ? renderLeftActions : undefined}
          renderRightActions={trailingCount > 0 ? renderRightActions : undefined}
          leftThreshold={SWIPE_ACTION_ITEM_WIDTH * SWIPE_OPEN_THRESHOLD_SHARE}
          rightThreshold={trailingWidth * SWIPE_OPEN_THRESHOLD_SHARE}
        >
          {props.children}
        </ReanimatedSwipeable>
      </View>
    </Animated.View>
  );
}

function withClose(action: ThreadSwipeAction, close: () => void): ThreadSwipeAction {
  const menu = action.menu;
  return {
    ...action,
    menu:
      menu === undefined
        ? undefined
        : {
            ...menu,
            onPressAction: (event) => {
              close();
              menu.onPressAction(event);
            },
          },
    onPress: () => {
      close();
      action.onPress();
    },
  };
}

/** Reports when a drag crosses either full-swipe threshold; renders nothing. */
function SwipeArmedReaction(props: {
  readonly translation: SharedValue<number>;
  readonly thresholds: { readonly leading: number | null; readonly trailing: number | null };
  readonly onArmedChange: (armed: SwipeSide | null) => void;
}) {
  const { translation, thresholds, onArmedChange } = props;
  useAnimatedReaction(
    () => armedSwipeSide(translation.value, thresholds),
    (armed, previous) => {
      if (armed !== previous) runOnJS(onArmedChange)(armed);
    },
    [thresholds, onArmedChange, translation],
  );
  return null;
}

const TONE_CLASS: Record<ThreadSwipeActionTone, string> = {
  primary: "bg-primary",
  secondary: "bg-subtle-strong",
  accent: "bg-accent",
};
const TONE_FOREGROUND: Record<Exclude<ThreadSwipeActionTone, "accent">, `--color-${string}`> = {
  primary: "--color-primary-foreground",
  secondary: "--color-foreground",
};
/** The accent is a mid blue in both themes; white reads on it in either. */
const ACCENT_FOREGROUND = "#ffffff";

function SwipeActionButton(props: {
  readonly action: ThreadSwipeAction;
  readonly actionsWidth: number;
  readonly entryRange: readonly [number, number];
  readonly fullSwipeThreshold: number | null;
  readonly side: SwipeSide;
  readonly stretchesOnFullSwipe: boolean;
  readonly translation: SharedValue<number>;
}) {
  const {
    action,
    actionsWidth,
    entryRange: [entryRangeStart, entryRangeEnd],
    side,
    stretchesOnFullSwipe,
    translation,
  } = props;
  // Without a full swipe the button never stretches; park the threshold out of reach.
  const threshold = props.fullSwipeThreshold ?? Number.MAX_SAFE_INTEGER;
  const sign = side === "trailing" ? -1 : 1;
  const circleSize = SWIPE_ACTION_CIRCLE_SIZE;
  const themed = useThemeColor(
    action.tone === "accent" ? "--color-primary-foreground" : TONE_FOREGROUND[action.tone],
  );
  const foreground = action.tone === "accent" ? ACCENT_FOREGROUND : themed;
  const actionStyle = useAnimatedStyle(() => {
    const reveal = Math.max(sign * translation.value, 0);
    const entryProgress = interpolate(
      reveal,
      [entryRangeStart, entryRangeEnd],
      [0, 1],
      Extrapolation.CLAMP,
    );
    const stretch = Math.max(reveal - actionsWidth, 0);
    const fullSwipeProgress = interpolate(
      reveal,
      [actionsWidth, threshold + 20],
      [0, 1],
      Extrapolation.CLAMP,
    );
    return {
      opacity: stretchesOnFullSwipe ? entryProgress : entryProgress * (1 - fullSwipeProgress),
      transform: [
        {
          translateX:
            -sign * interpolate(entryProgress, [0, 1], [22, 0]) +
            (stretchesOnFullSwipe ? 0 : sign * stretch),
        },
        { scale: interpolate(entryProgress, [0, 1], [0.78, 1]) },
      ],
    };
  });
  const circleStyle = useAnimatedStyle(() => {
    const reveal = Math.max(sign * translation.value, 0);
    const stretch = stretchesOnFullSwipe ? Math.max(reveal - actionsWidth, 0) : 0;
    // Trailing grows toward the row on its left; leading grows to the right from its anchor.
    return {
      transform: [{ translateX: side === "trailing" ? -stretch : 0 }],
      width: circleSize + stretch,
    };
  });
  const iconStyle = useAnimatedStyle(() => {
    const reveal = Math.max(sign * translation.value, 0);
    const stretch = stretchesOnFullSwipe ? Math.max(reveal - actionsWidth, 0) : 0;
    const armedProgress = interpolate(
      reveal,
      [threshold, threshold + 20],
      [0, 1],
      Extrapolation.CLAMP,
    );
    return { transform: [{ translateX: sign * stretch * (0.5 + armedProgress * 0.5) }] };
  });
  const labelStyle = useAnimatedStyle(() => {
    if (!stretchesOnFullSwipe) return { opacity: 1 };
    const reveal = Math.max(sign * translation.value, 0);
    const stretch = Math.max(reveal - actionsWidth, 0);
    return {
      opacity: interpolate(reveal, [threshold - 24, threshold], [1, 0], Extrapolation.CLAMP),
      transform: [{ translateX: sign * stretch * 0.5 }],
    };
  });

  const menu = action.menu;
  const button = (
    <Pressable
      accessibilityLabel={action.accessibilityLabel}
      accessibilityRole="button"
      onPress={menu === undefined ? action.onPress : undefined}
      style={({ pressed }) => ({
        alignItems: "center",
        height: "100%",
        justifyContent: "center",
        opacity: pressed ? 0.72 : 1,
        width: "100%",
      })}
    >
      <View style={{ height: circleSize, width: circleSize }}>
        <Animated.View
          className={TONE_CLASS[action.tone]}
          style={[
            { borderRadius: 999, height: circleSize, left: 0, position: "absolute", top: 0 },
            circleStyle,
          ]}
        />
        <Animated.View
          style={[
            {
              alignItems: "center",
              height: circleSize,
              justifyContent: "center",
              left: 0,
              position: "absolute",
              top: 0,
              width: circleSize,
            },
            iconStyle,
          ]}
        >
          <SymbolView
            name={action.icon}
            size={SWIPE_ACTION_ICON_SIZE}
            tintColor={foreground}
            type="monochrome"
          />
        </Animated.View>
      </View>
      <Animated.View style={[{ height: 14, justifyContent: "center", paddingTop: 2 }, labelStyle]}>
        <Text className="font-ryco-medium text-[10px] text-foreground-muted" numberOfLines={1}>
          {action.label}
        </Text>
      </Animated.View>
    </Pressable>
  );

  return (
    <Animated.View
      style={[
        {
          alignItems: "center",
          height: "100%",
          justifyContent: "center",
          width: SWIPE_ACTION_ITEM_WIDTH,
          zIndex: stretchesOnFullSwipe ? 2 : 1,
        },
        actionStyle,
      ]}
    >
      {menu === undefined ? (
        button
      ) : (
        <MenuView
          actions={menu.actions}
          title={menu.title}
          onPressAction={({ nativeEvent }: NativeActionEvent) =>
            menu.onPressAction(nativeEvent.event)
          }
          style={{ height: "100%", width: "100%" }}
        >
          {button}
        </MenuView>
      )}
    </Animated.View>
  );
}
