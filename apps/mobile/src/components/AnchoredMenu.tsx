import { appMotion } from "../lib/motion";
import type { MenuAction, MenuComponentProps } from "@react-native-menu/menu";
import { BlurView } from "expo-blur";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ColorValue, StyleProp, TextStyle, ViewStyle } from "react-native";
import {
  BackHandler,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useColorScheme,
  View,
} from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { appBlurTargetRef } from "../lib/appBlurTarget";
import { useThemeColor } from "../lib/useThemeColor";
import { cn } from "../lib/cn";
import { type AppSymbolName, SymbolView } from "./AppSymbol";
import { AppText as Text } from "./AppText";
import { OverlayPortal } from "./OverlayPortal";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { filterAnchoredMenuActions } from "./anchoredMenuModel";

const MENU_WIDTH = 250;
const SCREEN_MARGIN = 12;
const ANCHOR_GAP = 6;
// Anchor position is snapshotted in window coordinates when the menu opens;
// the overlay root measures itself the same way, and the menu is placed from
// the delta. Both snapshots are taken at open time so later reflows (keyboard
// show/hide, screen transitions) can't flip an opens-up menu to opens-down
// mid-presentation.
type AnchorSnapshot = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

type OverlayFrame = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type AnchoredMenuProps = {
  readonly actions: readonly MenuAction[];
  readonly title?: string;
  readonly headerAction?: MenuAction;
  readonly footer?: ReactNode;
  readonly closeOnSelect?: boolean;
  readonly menuWidth?: number;
  readonly submenuWidth?: number;
  readonly initialSubmenuId?: string;
  readonly searchable?: boolean;
  readonly searchPlaceholder?: string;
  readonly emptyMessage?: string;
  readonly renderIcon?: (action: MenuAction) => ReactNode;
  readonly renderTitle?: (action: MenuAction) => ReactNode;
  readonly subtitleStyle?: StyleProp<TextStyle>;
  readonly onClose?: () => void;
  readonly onPressAction?: MenuComponentProps["onPressAction"];
  /** Applied to the anchor wrapper — call sites flex these to fill toolbars. */
  readonly className?: string;
  readonly style?: StyleProp<ViewStyle>;
  /**
   * Plain children open the menu on tap (the wrapper owns the press). A
   * render function keeps the children interactive and hands them `open` to
   * call from their own gesture — e.g. a row that selects on tap and opens
   * this menu on long-press.
   */
  readonly children: ReactNode | ((open: () => void) => ReactNode);
};

function MenuAnchorContent(props: {
  readonly render: (onOpen: () => void) => ReactNode;
  readonly onOpen: () => void;
}) {
  return props.render(props.onOpen);
}

/** Mount the native effect only after the animated shell has nonzero bounds.
 * UIKit otherwise initializes the effect against the opening frame's zero size.
 */
function MenuBackdrop({ dark }: { readonly dark: boolean }) {
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
      <View style={StyleSheet.absoluteFill} className="bg-card-translucent" />
    </View>
  );
}

/** In-window dropdown for composer controls. Opening it preserves keyboard focus. */
export function AnchoredMenu(props: AnchoredMenuProps) {
  const { onClose, onPressAction, closeOnSelect = true } = props;
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const [anchor, setAnchor] = useState<AnchorSnapshot | null>(null);
  const [path, setPath] = useState<readonly MenuAction[]>([]);
  // Height of the modal's root view, in the modal's own coordinate space.
  // Menus that flip above their anchor are pinned by their BOTTOM edge
  // (bottom = rootHeight - anchorTop), so drill-in height changes grow
  // upward without any re-measurement — positioning them via `top` from the
  // menu's measured height made every submenu transition settle over two
  // frames and jitter.
  const [rootHeight, setRootHeight] = useState<number | null>(null);
  // Window frame of the overlay root, measured on layout. Anchor coordinates
  // are converted into this frame, so the menu lands correctly no matter
  // where the portal host sits (status bar, keyboard resize, etc.).
  const [overlay, setOverlay] = useState<OverlayFrame | null>(null);
  const anchorRef = useRef<View>(null);
  const overlayRef = useRef<View>(null);
  const closingRef = useRef(false);
  const progress = useSharedValue(0);
  const frameWidth = useSharedValue(0);
  const frameHeight = useSharedValue(0);
  const frameLeft = useSharedValue(0);
  const measuredFrame = useRef(false);
  const contentOpacity = useSharedValue(1);
  const contentOffset = useSharedValue(0);
  const pendingNavigation = useRef<{
    path: readonly MenuAction[];
    direction: number;
    committed: boolean;
  } | null>(null);

  const finishNavigation = useCallback(() => {
    pendingNavigation.current = null;
  }, []);
  const commitNavigation = useCallback(() => {
    const pending = pendingNavigation.current;
    if (!pending || closingRef.current) return;
    pending.committed = true;
    setPath(pending.path);
    setQuery("");
  }, []);
  const navigate = useCallback(
    (nextPath: readonly MenuAction[], direction: number) => {
      if (closingRef.current || pendingNavigation.current) return;
      pendingNavigation.current = { path: nextPath, direction, committed: false };
      const timing = appMotion.levelOut;
      contentOffset.set(withTiming(-direction * 4, timing));
      contentOpacity.set(
        withTiming(0, timing, (finished) => {
          if (finished) runOnJS(commitNavigation)();
        }),
      );
    },
    [commitNavigation, contentOffset, contentOpacity],
  );

  // Change the content while it is transparent, then reveal the new level.
  // Keep the search field mounted so provider navigation never takes focus.
  useEffect(() => {
    const pending = pendingNavigation.current;
    if (!pending?.committed || pending.path !== path) return;
    contentOffset.set(pending.direction * 4);
    const timing = appMotion.levelIn;
    contentOffset.set(withTiming(0, timing));
    contentOpacity.set(
      withTiming(1, timing, (finished) => {
        if (finished) runOnJS(finishNavigation)();
      }),
    );
  }, [path, contentOffset, contentOpacity, finishNavigation]);
  const contentStyle = useAnimatedStyle(() => ({
    opacity: contentOpacity.get(),
    transform: [{ translateX: contentOffset.get() }],
  }));

  const isDarkMode = useColorScheme() === "dark";
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const keyboardHeight = useKeyboardState((state) => state.height);
  const rippleColor = useThemeColor("--color-subtle");
  const iconColor = useThemeColor("--color-icon");
  const iconSubtleColor = useThemeColor("--color-icon-subtle");
  const textColor = useThemeColor("--color-foreground");
  const dangerColor = useThemeColor("--color-danger-foreground");

  const finishClose = useCallback(() => {
    measuredFrame.current = false;
    frameHeight.set(0);
    setAnchor(null);
    setPath([]);
    setOverlay(null);
    setRootHeight(null);
    setQuery("");
    contentOpacity.set(1);
    contentOffset.set(0);
    closingRef.current = false;
    onClose?.();
  }, [onClose, contentOpacity, contentOffset, frameHeight]);

  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    pendingNavigation.current = null;
    cancelAnimation(contentOpacity);
    cancelAnimation(contentOffset);
    progress.set(
      withTiming(0, appMotion.exit, (finished) => {
        if (finished) runOnJS(finishClose)();
      }),
    );
  }, [finishClose, progress, contentOpacity, contentOffset]);

  useEffect(
    () => () => {
      cancelAnimation(progress);
      cancelAnimation(contentOpacity);
      cancelAnimation(contentOffset);
    },
    [progress, contentOpacity, contentOffset],
  );

  const handleOpen = () => {
    if (anchor !== null || closingRef.current) return;
    anchorRef.current?.measureInWindow((x, y, width, height) => {
      setAnchor({ x, y, width, height });
      const initial = props.actions.find(
        (action) => action.id === props.initialSubmenuId && action.subactions?.length,
      );
      setPath(initial ? [initial] : []);
    });
  };

  const menuOpen = anchor !== null;
  useEffect(() => {
    if (!menuOpen) return;
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
  }, [menuOpen]);

  const measureOverlay = useCallback(() => {
    overlayRef.current?.measureInWindow((x, y, width, height) => {
      setOverlay({ x, y, width, height });
      setRootHeight(height);
    });
  }, []);

  // The dropdown renders in-window (no Modal takes focus), so the hardware
  // back gesture needs explicit handling while it is open. Back steps out of
  // a drilled-in submenu one level at a time (mirroring the tappable parent
  // header) before closing the menu. Under predictive back
  // (enableOnBackInvokedCallback) this stays correct: back reaches JS
  // through always-registered OnBackPressedDispatcher callbacks (react-native
  // core on Android 16+, withAndroidPredictiveBackCompat on 13-15), which
  // also keeps the system from playing a "leave app" preview while the menu
  // merely closes.
  const submenuDepth = path.length;
  useEffect(() => {
    if (anchor === null) {
      return;
    }
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (submenuDepth > 0) {
        navigate(path.slice(0, -1), -1);
      } else {
        close();
      }
      return true;
    });
    return () => subscription.remove();
  }, [anchor, close, submenuDepth, navigate, path]);

  const pathParent = path.length > 0 ? path[path.length - 1] : null;
  const parent = pathParent
    ? (props.actions.find((action) => action.id === pathParent.id) ?? pathParent)
    : null;
  const levelActions = filterAnchoredMenuActions(props.actions, parent?.subactions, query);
  const menuWidth = Math.min(
    (parent ? props.submenuWidth : undefined) ?? props.menuWidth ?? MENU_WIDTH,
    (overlay?.width ?? 400) - SCREEN_MARGIN * 2,
  );

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
        : local.x + local.width - menuWidth;
  const left =
    overlay === null
      ? 0
      : Math.min(Math.max(preferredLeft, SCREEN_MARGIN), overlay.width - menuWidth - SCREEN_MARGIN);
  // The keyboard stays up while the menu is open (in-window overlay, no
  // focus change), so the space it covers is not usable — without this the
  // composer-pill menus "open down" into the IME and can't be tapped.
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
  const maxHeight = Math.min(opensDown ? spaceBelow : spaceAbove, 480);
  // The menu needs the overlay frame before it can be placed; it stays
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
    frameWidth.set(measuredFrame.current ? withTiming(menuWidth, appMotion.resize) : menuWidth);
    frameLeft.set(measuredFrame.current ? withTiming(left, appMotion.resize) : left);
  }, [placeable, menuWidth, left, frameWidth, frameLeft]);
  const frameStyle = useAnimatedStyle(() => ({
    width: frameWidth.get(),
    height: frameHeight.get(),
    left: frameLeft.get(),
  }));

  const onPressItem = useCallback(
    (action: MenuAction) => {
      if (closingRef.current || pendingNavigation.current) return;
      if ((action.subactions?.length ?? 0) > 0) {
        navigate([...path, action], 1);
        return;
      }
      if (closeOnSelect) close();
      if (action.id !== undefined) {
        onPressAction?.({
          nativeEvent: { event: action.id },
        } as Parameters<NonNullable<MenuComponentProps["onPressAction"]>>[0]);
      }
    },
    [close, onPressAction, closeOnSelect, navigate, path],
  );

  return (
    <>
      {typeof props.children === "function" ? (
        <View ref={anchorRef} collapsable={false} className={props.className} style={props.style}>
          <MenuAnchorContent render={props.children} onOpen={handleOpen} />
        </View>
      ) : (
        <Pressable
          ref={anchorRef}
          accessibilityRole="button"
          className={props.className}
          collapsable={false}
          style={props.style}
          onPress={handleOpen}
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
                      Math.max(0, Math.min(menuWidth, local.x + local.width / 2 - left)),
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
                {/* Frosted backdrop: blur of the app content behind the menu,
                  washed with the translucent card tone so rows keep contrast. */}
                <MenuBackdrop dark={isDarkMode} />
                <Animated.View
                  onLayout={({ nativeEvent }) => {
                    const height = nativeEvent.layout.height + 2;
                    frameHeight.set(
                      measuredFrame.current ? withTiming(height, appMotion.resize) : height,
                    );
                    measuredFrame.current = true;
                  }}
                  style={[
                    {
                      position: "absolute",
                      top: 0,
                      width: menuWidth - 2,
                      maxHeight: Math.max(42, maxHeight - 2),
                    },
                    contentStyle,
                  ]}
                >
                  {/* keyboardShouldPersistTaps: the menu often opens over an
                  active editor; the first item tap must act, not just
                  dismiss the keyboard. */}
                  {parent !== null ? (
                    // Keep provider navigation reachable while the model list scrolls.
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={
                        props.title ? `Choose ${props.title.toLocaleLowerCase()}` : "Back to menu"
                      }
                      className="min-h-11 flex-row items-center gap-2 px-3.5 py-2.5"
                      onPress={() => {
                        navigate(path.slice(0, -1), -1);
                      }}
                    >
                      <SymbolView
                        name="chevron.left"
                        size={13}
                        tintColor={iconColor}
                        type="monochrome"
                      />
                      {props.renderIcon?.(parent)}
                      <Text className="text-sm font-ryco-bold text-foreground">{parent.title}</Text>
                    </Pressable>
                  ) : props.title ? (
                    <>
                      <View className="min-h-11 flex-row items-center justify-between px-3.5 py-2">
                        <Text className="flex-1 text-xs text-foreground-muted">{props.title}</Text>
                        {props.headerAction ? (
                          <Pressable
                            accessibilityRole="button"
                            disabled={props.headerAction.attributes?.disabled}
                            onPress={() => onPressItem(props.headerAction!)}
                            className="min-h-11 flex-row items-center gap-1.5 px-2 disabled:opacity-40"
                          >
                            <Text className="text-sm font-ryco-bold">
                              {props.headerAction.title}
                            </Text>
                            <SymbolView
                              name="plus"
                              size={14}
                              tintColor={iconColor}
                              type="monochrome"
                            />
                          </Pressable>
                        ) : null}
                      </View>
                      <View className="h-px bg-border" />
                    </>
                  ) : null}
                  {props.searchable ? (
                    <View className="mx-3 my-2 flex-row items-center rounded-xl bg-subtle px-2.5">
                      <SymbolView
                        name="magnifyingglass"
                        size={14}
                        tintColor={iconSubtleColor}
                        type="monochrome"
                      />
                      <TextInput
                        accessibilityLabel={props.searchPlaceholder ?? "Search models"}
                        placeholder={props.searchPlaceholder ?? "Search models"}
                        placeholderTextColor={iconSubtleColor as string}
                        value={query}
                        onChangeText={setQuery}
                        autoCapitalize="none"
                        autoCorrect={false}
                        className="h-10 flex-1 px-2 text-sm"
                        style={{ color: textColor as string }}
                      />
                    </View>
                  ) : null}
                  <ScrollView
                    bounces={false}
                    keyboardShouldPersistTaps="always"
                    showsVerticalScrollIndicator={false}
                  >
                    {levelActions.length === 0 ? (
                      <Text className="p-4 text-sm text-foreground-muted">
                        {props.emptyMessage ?? "No models match that search."}
                      </Text>
                    ) : null}
                    {levelActions.map((action, index) => {
                      const destructive = action.attributes?.destructive ?? false;
                      const disabled = action.attributes?.disabled ?? false;
                      const hasSubmenu = (action.subactions?.length ?? 0) > 0;
                      return (
                        <Pressable
                          key={action.id ?? `${index}-${action.title}`}
                          android_ripple={{ color: rippleColor }}
                          accessibilityRole={
                            hasSubmenu || action.state === undefined ? "button" : "radio"
                          }
                          accessibilityLabel={[action.title, action.subtitle]
                            .filter(Boolean)
                            .join(", ")}
                          accessibilityState={{
                            ...(action.state !== undefined && !hasSubmenu
                              ? { checked: action.state === "on" }
                              : {}),
                            disabled,
                          }}
                          disabled={disabled}
                          className={cn(
                            "min-h-11 flex-row items-center gap-2.5 px-3.5 py-2.5",
                            disabled && "opacity-45",
                          )}
                          onPress={() => onPressItem(action)}
                        >
                          {props.renderIcon?.(action)}
                          <View className="flex-1 gap-0.5">
                            {props.renderTitle ? (
                              props.renderTitle(action)
                            ) : (
                              <Text
                                style={
                                  action.titleColor === undefined
                                    ? undefined
                                    : { color: action.titleColor as ColorValue }
                                }
                                className={cn(
                                  // Same face as the pill labels that open these menus.
                                  "text-sm font-ryco-bold",
                                  destructive && "text-danger-foreground",
                                )}
                              >
                                {action.title}
                              </Text>
                            )}
                            {action.subtitle && !props.renderTitle ? (
                              <Text
                                style={props.subtitleStyle}
                                className="text-xs leading-snug text-foreground-muted"
                              >
                                {action.subtitle}
                              </Text>
                            ) : null}
                          </View>
                          {hasSubmenu ? (
                            <SymbolView
                              name="chevron.right"
                              size={13}
                              tintColor={iconSubtleColor}
                              type="monochrome"
                            />
                          ) : action.state === "on" ? (
                            <SymbolView
                              name="checkmark"
                              size={15}
                              tintColor={iconColor}
                              type="monochrome"
                            />
                          ) : action.image ? (
                            <SymbolView
                              name={action.image as AppSymbolName}
                              size={15}
                              tintColor={destructive ? dangerColor : iconColor}
                              type="monochrome"
                            />
                          ) : null}
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                  {props.footer}
                </Animated.View>
              </Animated.View>
            )}
          </View>
        </OverlayPortal>
      )}
    </>
  );
}
