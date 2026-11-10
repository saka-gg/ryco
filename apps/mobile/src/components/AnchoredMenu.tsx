import { appMotion } from "../lib/motion";
import type { MenuAction, MenuComponentProps } from "@react-native-menu/menu";
import type { ReactNode, Ref } from "react";
import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type { ColorValue, StyleProp, TextStyle, ViewStyle } from "react-native";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { useThemeColor } from "../lib/useThemeColor";
import { cn } from "../lib/cn";
import { type AppSymbolName, SymbolView } from "./AppSymbol";
import { AppText as Text } from "./AppText";
import { AnchoredPopover, type AnchoredPopoverHandle } from "./AnchoredPopover";
import { filterAnchoredMenuActions, resolveAnchoredMenuParent } from "./anchoredMenuModel";

const MENU_WIDTH = 250;

/** Opens the menu from code, e.g. the composer's `/model` command. */
export interface AnchoredMenuHandle {
  readonly open: () => void;
}

export type AnchoredMenuProps = {
  readonly ref?: Ref<AnchoredMenuHandle>;
  readonly actions: readonly MenuAction[];
  readonly title?: string;
  readonly headerAction?: MenuAction;
  readonly footer?: ReactNode;
  readonly closeOnSelect?: boolean;
  /** Actions that close the menu even when `closeOnSelect` is false (they open something else). */
  readonly closeOnSelectIds?: ReadonlySet<string>;
  /** Actions with a thin divider above them, grouping the list. */
  readonly separatorBeforeIds?: ReadonlySet<string>;
  /**
   * Actions drawn as a group's small muted heading ("Mode", "Access") rather than a row: the
   * desktop's labelled radio groups. They cannot be pressed.
   */
  readonly sectionTitleIds?: ReadonlySet<string>;
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

/** In-window dropdown for composer controls. Opening it preserves keyboard focus. */
export function AnchoredMenu({ ref, ...props }: AnchoredMenuProps) {
  const { onClose, onPressAction, closeOnSelect = true, closeOnSelectIds } = props;
  const popoverRef = useRef<AnchoredPopoverHandle>(null);
  const [query, setQuery] = useState("");
  const [path, setPath] = useState<readonly MenuAction[]>([]);
  const closingRef = useRef(false);
  const contentOpacity = useSharedValue(1);
  const contentOffset = useSharedValue(0);
  const pendingNavigation = useRef<{
    path: readonly MenuAction[];
    direction: number;
    committed: boolean;
  } | null>(null);

  useImperativeHandle(ref, () => ({ open: () => popoverRef.current?.open() }));

  const finishNavigation = () => {
    pendingNavigation.current = null;
  };
  const commitNavigation = () => {
    const pending = pendingNavigation.current;
    if (!pending || closingRef.current) return;
    pending.committed = true;
    setPath(pending.path);
    setQuery("");
  };
  const navigate = (nextPath: readonly MenuAction[], direction: number) => {
    if (closingRef.current || pendingNavigation.current) return;
    pendingNavigation.current = { path: nextPath, direction, committed: false };
    const timing = appMotion.levelOut;
    contentOffset.set(withTiming(-direction * 4, timing));
    contentOpacity.set(
      withTiming(0, timing, (finished) => {
        if (finished) runOnJS(commitNavigation)();
      }),
    );
  };

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
  }, [path, contentOffset, contentOpacity]);
  const contentStyle = useAnimatedStyle(() => ({
    opacity: contentOpacity.get(),
    transform: [{ translateX: contentOffset.get() }],
  }));

  useEffect(
    () => () => {
      cancelAnimation(contentOpacity);
      cancelAnimation(contentOffset);
    },
    [contentOpacity, contentOffset],
  );

  const rippleColor = useThemeColor("--color-subtle");
  const iconColor = useThemeColor("--color-icon");
  const iconSubtleColor = useThemeColor("--color-icon-subtle");
  const textColor = useThemeColor("--color-foreground");
  const dangerColor = useThemeColor("--color-danger-foreground");

  const onOpen = () => {
    closingRef.current = false;
    const initial = props.actions.find(
      (action) => action.id === props.initialSubmenuId && action.subactions?.length,
    );
    setPath(initial ? [initial] : []);
  };
  const onCloseStart = () => {
    closingRef.current = true;
    pendingNavigation.current = null;
    cancelAnimation(contentOpacity);
    cancelAnimation(contentOffset);
  };
  const finishClose = () => {
    setPath([]);
    setQuery("");
    contentOpacity.set(1);
    contentOffset.set(0);
    onClose?.();
  };

  // Back steps out of a drilled-in submenu one level at a time (mirroring the
  // tappable parent header) before the popover closes.
  const onBack = () => {
    if (path.length === 0) return false;
    navigate(path.slice(0, -1), -1);
    return true;
  };

  const parent = resolveAnchoredMenuParent(props.actions, path);
  const levelActions = filterAnchoredMenuActions(props.actions, parent?.subactions, query);
  const width = (parent ? props.submenuWidth : undefined) ?? props.menuWidth ?? MENU_WIDTH;

  const onPressItem = (action: MenuAction) => {
    if (closingRef.current || pendingNavigation.current) return;
    if ((action.subactions?.length ?? 0) > 0) {
      navigate([...path, action], 1);
      return;
    }
    if (closeOnSelect || (action.id !== undefined && closeOnSelectIds?.has(action.id)))
      popoverRef.current?.close();
    // A nested submenu folds part of its parent's list, so a pick that keeps
    // the menu open returns to that list, where the choice now shows.
    else if (path.length > 1) navigate(path.slice(0, -1), -1);
    if (action.id !== undefined) {
      onPressAction?.({
        nativeEvent: { event: action.id },
      } as Parameters<NonNullable<MenuComponentProps["onPressAction"]>>[0]);
    }
  };

  return (
    <AnchoredPopover
      ref={popoverRef}
      width={width}
      onOpen={onOpen}
      onCloseStart={onCloseStart}
      onClose={finishClose}
      onBack={onBack}
      className={props.className}
      style={props.style}
      renderContent={({ maxHeight }) => (
        <Animated.View style={[{ maxHeight }, contentStyle]}>
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
              <SymbolView name="chevron.left" size={13} tintColor={iconColor} type="monochrome" />
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
                    <Text className="text-sm font-ryco-bold">{props.headerAction.title}</Text>
                    <SymbolView name="plus" size={14} tintColor={iconColor} type="monochrome" />
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
              const separated =
                index > 0 &&
                action.id !== undefined &&
                (props.separatorBeforeIds?.has(action.id) ?? false);
              if (action.id !== undefined && props.sectionTitleIds?.has(action.id)) {
                return (
                  <View key={action.id}>
                    {separated ? <View className="mx-3 my-1 h-px bg-border" /> : null}
                    <Text
                      accessibilityRole="header"
                      className="px-3.5 pb-1 pt-2 text-xs font-ryco-medium text-foreground-muted"
                    >
                      {action.title}
                    </Text>
                  </View>
                );
              }
              return (
                <View key={action.id ?? `${index}-${action.title}`}>
                  {separated ? <View className="mx-3 my-1 h-px bg-border" /> : null}
                  <Pressable
                    android_ripple={{ color: rippleColor }}
                    accessibilityRole={
                      hasSubmenu || action.state === undefined ? "button" : "radio"
                    }
                    accessibilityLabel={[action.title, action.subtitle].filter(Boolean).join(", ")}
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
                </View>
              );
            })}
          </ScrollView>
          {props.footer}
        </Animated.View>
      )}
    >
      {props.children}
    </AnchoredPopover>
  );
}
