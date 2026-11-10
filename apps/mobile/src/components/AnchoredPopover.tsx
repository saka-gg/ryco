import { appMotion } from "../lib/motion";
import { BlurView } from "expo-blur";
import type { ReactNode, Ref } from "react";
import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { BackHandler, Keyboard, Pressable, StyleSheet, useColorScheme, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { appBlurTargetRef } from "../lib/appBlurTarget";
import { OverlayPortal } from "./OverlayPortal";

// The in-window popover every composer control opens: the dark grey `--color-popover` plate over
// a blur of the app, placed against its anchor, above the keyboard. `AnchoredMenu` (a list of
// actions) and the composer's model picker (provider tabs, rows, tuning dial) both render inside
// it, so placement, motion and dismissal stay one implementation.

const DEFAULT_WIDTH = 250;
const SCREEN_MARGIN = 12;
const ANCHOR_GAP = 6;
const MAX_HEIGHT = 480;
// Anchor position is snapshotted in window coordinates when the popover opens;
// the overlay root measures itself the same way, and the popover is placed from
// the delta. Both snapshots are taken at open time so later reflows (keyboard
// show/hide, screen transitions) can't flip an opens-up popover to opens-down
// mid-presentation.
type Frame = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** Opens or closes the popover from code, e.g. the composer's `/model` command. */
export interface AnchoredPopoverHandle {
  readonly open: () => void;
  readonly close: () => void;
}

export interface AnchoredPopoverContentContext {
  /** Width of the content, inside the 1pt border. */
  readonly width: number;
  /** Height the content may take, inside the border. */
  readonly maxHeight: number;
}

export type AnchoredPopoverProps = {
  readonly ref?: Ref<AnchoredPopoverHandle>;
  /** Wanted width; the popover narrows to the screen. */
  readonly width?: number;
  /** Before the first frame: reset the content's own state. */
  readonly onOpen?: () => void;
  /** The close animation started. */
  readonly onCloseStart?: () => void;
  /** The popover is gone. */
  readonly onClose?: () => void;
  /** The hardware back gesture: true when the content handled it (e.g. left a submenu). */
  readonly onBack?: () => boolean;
  readonly accessibilityLabel?: string;
  /** Applied to the anchor wrapper — call sites flex these to fill toolbars. */
  readonly className?: string;
  readonly style?: StyleProp<ViewStyle>;
  /**
   * Plain children open the popover on tap (the wrapper owns the press). A
   * render function keeps the children interactive and hands them `open` to
   * call from their own gesture.
   */
  readonly children: ReactNode | ((open: () => void) => ReactNode);
  readonly renderContent: (context: AnchoredPopoverContentContext) => ReactNode;
};

function AnchorContent(props: {
  readonly render: (onOpen: () => void) => ReactNode;
  readonly onOpen: () => void;
}) {
  return props.render(props.onOpen);
}

/** Mount the native effect only after the animated shell has nonzero bounds.
 * UIKit otherwise initializes the effect against the opening frame's zero size.
 */
function PopoverBackdrop({ dark }: { readonly dark: boolean }) {
  const [ready, setReady] = useState(false);
  return (
    <View
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      onLayout={({ nativeEvent: { layout } }) => {
        if (layout.width > 0 && layout.height > 0) setReady(true);
      }}
    >
      {ready ? (
        <BlurView
          blurMethod="dimezisBlurView"
          blurTarget={appBlurTargetRef}
          intensity={60}
          tint={dark ? "systemMaterialDark" : "systemMaterialLight"}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <View style={StyleSheet.absoluteFill} className="bg-popover" />
    </View>
  );
}

export function AnchoredPopover({ ref, ...props }: AnchoredPopoverProps) {
  const { onClose, onCloseStart, onBack, onOpen } = props;
  const insets = useSafeAreaInsets();
  const [anchor, setAnchor] = useState<Frame | null>(null);
  // Height of the overlay's root view, in its own coordinate space. Popovers
  // that flip above their anchor are pinned by their BOTTOM edge
  // (bottom = rootHeight - anchorTop), so content height changes grow upward
  // without re-measurement.
  const [rootHeight, setRootHeight] = useState<number | null>(null);
  // Window frame of the overlay root, measured on layout. Anchor coordinates
  // are converted into this frame, so the popover lands correctly no matter
  // where the portal host sits (status bar, keyboard resize, etc.).
  const [overlay, setOverlay] = useState<Frame | null>(null);
  const anchorRef = useRef<View>(null);
  const overlayRef = useRef<View>(null);
  const closingRef = useRef(false);
  const progress = useSharedValue(0);
  const frameWidth = useSharedValue(0);
  const frameHeight = useSharedValue(0);
  const frameLeft = useSharedValue(0);
  const measuredFrame = useRef(false);

  const isDarkMode = useColorScheme() === "dark";
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const keyboardHeight = useKeyboardState((state) => state.height);

  const finishClose = () => {
    measuredFrame.current = false;
    frameHeight.set(0);
    setAnchor(null);
    setOverlay(null);
    setRootHeight(null);
    closingRef.current = false;
    onClose?.();
  };

  const close = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    onCloseStart?.();
    progress.set(
      withTiming(0, appMotion.exit, (finished) => {
        if (finished) runOnJS(finishClose)();
      }),
    );
  };

  useEffect(() => () => cancelAnimation(progress), [progress]);

  const open = () => {
    if (anchor !== null || closingRef.current) return;
    anchorRef.current?.measureInWindow((x, y, width, height) => {
      onOpen?.();
      setAnchor({ x, y, width, height });
    });
  };
  useImperativeHandle(ref, () => ({ open, close }));

  const isOpen = anchor !== null;
  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    let frame: number | undefined;
    const remeasure = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        anchorRef.current?.measureInWindow((x, y, width, height) => {
          if (active && !closingRef.current) setAnchor({ x, y, width, height });
        });
      });
    };
    const shown = Keyboard.addListener("keyboardDidShow", remeasure);
    const hidden = Keyboard.addListener("keyboardDidHide", remeasure);
    return () => {
      active = false;
      shown.remove();
      hidden.remove();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [isOpen]);

  const measureOverlay = () => {
    overlayRef.current?.measureInWindow((x, y, width, height) => {
      setOverlay({ x, y, width, height });
      setRootHeight(height);
    });
  };

  // The popover renders in-window (no Modal takes focus), so the hardware back
  // gesture needs explicit handling while it is open: the content gets it first
  // (a submenu steps out one level), else the popover closes.
  useEffect(() => {
    if (!isOpen) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (onBack?.()) return true;
      close();
      return true;
    });
    return () => subscription.remove();
  }, [isOpen, close, onBack]);

  const width = Math.min(props.width ?? DEFAULT_WIDTH, (overlay?.width ?? 400) - SCREEN_MARGIN * 2);

  // Anchor in overlay-local coordinates (both measured in window space).
  const local =
    anchor === null || overlay === null
      ? null
      : {
          x: anchor.x - overlay.x,
          y: anchor.y - overlay.y,
          width: anchor.width,
          height: anchor.height,
        };
  const preferredLeft =
    local === null || overlay === null
      ? 0
      : local.x + local.width / 2 <= overlay.width / 2
        ? local.x
        : local.x + local.width - width;
  const left =
    overlay === null
      ? 0
      : Math.min(Math.max(preferredLeft, SCREEN_MARGIN), overlay.width - width - SCREEN_MARGIN);
  // The keyboard stays up while the popover is open (in-window overlay, no
  // focus change), so the space it covers is not usable — without this the
  // composer menus "open down" into the IME and can't be tapped.
  const usableBottom =
    overlay === null ? 0 : overlay.height - (keyboardVisible ? keyboardHeight : 0);
  // The keyboard can resize the composer after its opening position was
  // measured. Keep the popup above the visible keyboard throughout that move.
  const anchorTop =
    local === null ? 0 : Math.min(local.y, usableBottom - local.height - SCREEN_MARGIN);
  const spaceBelow =
    local === null || overlay === null
      ? 0
      : usableBottom - (anchorTop + local.height) - ANCHOR_GAP - SCREEN_MARGIN;
  const topInset = Math.max(0, insets.top - (overlay?.y ?? 0));
  const spaceAbove = local === null ? 0 : anchorTop - ANCHOR_GAP - SCREEN_MARGIN - topInset;
  const opensDown = spaceBelow >= 280 || spaceBelow >= spaceAbove;
  const maxHeight = Math.min(opensDown ? spaceBelow : spaceAbove, MAX_HEIGHT);
  // The popover needs the overlay frame before it can be placed; it stays
  // unmounted for that first frame so the fade-in plays at the final position.
  const placeable = local !== null && rootHeight !== null;
  useEffect(() => {
    if (placeable && !closingRef.current) {
      progress.set(withTiming(1, appMotion.enter));
    }
  }, [placeable, progress]);
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.get(),
    transform: [
      { translateY: (1 - progress.get()) * (opensDown ? -6 : 6) },
      { scale: 0.96 + 0.04 * progress.get() },
    ],
  }));

  useEffect(() => {
    if (!placeable) return;
    frameWidth.set(measuredFrame.current ? withTiming(width, appMotion.resize) : width);
    frameLeft.set(measuredFrame.current ? withTiming(left, appMotion.resize) : left);
  }, [placeable, width, left, frameWidth, frameLeft]);
  const frameStyle = useAnimatedStyle(() => ({
    width: frameWidth.get(),
    height: frameHeight.get(),
    left: frameLeft.get(),
  }));

  const contentMaxHeight = Math.max(42, maxHeight - 2);
  return (
    <>
      {typeof props.children === "function" ? (
        <View ref={anchorRef} collapsable={false} className={props.className} style={props.style}>
          <AnchorContent render={props.children} onOpen={open} />
        </View>
      ) : (
        <Pressable
          ref={anchorRef}
          accessibilityRole="button"
          accessibilityLabel={props.accessibilityLabel}
          className={props.className}
          collapsable={false}
          style={props.style}
          onPress={open}
        >
          <View pointerEvents="none">{props.children}</View>
        </Pressable>
      )}
      {anchor === null ? null : (
        <OverlayPortal>
          <View
            ref={overlayRef}
            collapsable={false}
            className="absolute inset-0"
            onLayout={measureOverlay}
          >
            <Pressable accessible={false} className="absolute inset-0" onPress={close} />
            {!placeable || local === null ? null : (
              <Animated.View
                accessibilityViewIsModal
                className="absolute overflow-hidden rounded-[20px] border border-border shadow-2xl"
                style={[
                  {
                    // Numeric coordinates preserve fractional measurements without
                    // passing them through React Native's CSS-string parser.
                    transformOrigin: [
                      Math.max(0, Math.min(width, local.x + local.width / 2 - left)),
                      opensDown ? 0 : "100%",
                      0,
                    ],
                    ...(opensDown
                      ? { top: anchorTop + local.height + ANCHOR_GAP }
                      : { bottom: (rootHeight ?? 0) - anchorTop + ANCHOR_GAP }),
                  },
                  animatedStyle,
                  frameStyle,
                ]}
              >
                {/* Frosted backdrop: blur of the app content behind the popover,
                  washed with the popover tone so rows keep contrast. */}
                <PopoverBackdrop dark={isDarkMode} />
                <View
                  onLayout={({ nativeEvent }) => {
                    const height = nativeEvent.layout.height + 2;
                    frameHeight.set(
                      measuredFrame.current ? withTiming(height, appMotion.resize) : height,
                    );
                    measuredFrame.current = true;
                  }}
                  style={{
                    position: "absolute",
                    top: 0,
                    width: width - 2,
                    maxHeight: contentMaxHeight,
                  }}
                >
                  {props.renderContent({ width: width - 2, maxHeight: contentMaxHeight })}
                </View>
              </Animated.View>
            )}
          </View>
        </OverlayPortal>
      )}
    </>
  );
}
