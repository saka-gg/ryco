import { useNavigation } from "@react-navigation/native";
import { useLayoutEffect, useState, type ReactNode } from "react";
import { View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import type { NativeTabStackHeaderOptions } from "./NativeTabsNavigator";
import { largeTitleCollapsed } from "./tabChromeModel";

/**
 * Put the tab's buttons and title in the header above the tabs while the tab
 * is in front. Call it from a tab's root screen.
 */
export function useTabStackHeader(header: NativeTabStackHeaderOptions): void {
  const navigation = useNavigation();
  useLayoutEffect(() => {
    navigation.setOptions({ stackHeader: header } as never);
  }, [header, navigation]);
}

/**
 * iOS's large title, drawn in the list: the big title scrolls away with the
 * content and the header shows the small one once it has gone. The native
 * large title cannot be used here, because the tab's list is not the stack
 * screen's own scroll view.
 */
export function useLargeTitleCollapse(): {
  readonly collapsed: boolean;
  readonly onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
} {
  const [collapsed, setCollapsed] = useState(false);
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = largeTitleCollapsed(
      event.nativeEvent.contentOffset.y + event.nativeEvent.contentInset.top,
    );
    if (next !== collapsed) setCollapsed(next);
  };
  return { collapsed, onScroll };
}

/** The tab's large title, with an optional line of controls under it. */
export function TabLargeTitle(props: { readonly title: string; readonly children?: ReactNode }) {
  return (
    <View className="pb-2">
      <Text
        accessibilityRole="header"
        className="px-4 pb-2 pt-1 font-ryco-bold text-[34px] leading-[41px] text-foreground"
        numberOfLines={1}
      >
        {props.title}
      </Text>
      {props.children}
    </View>
  );
}

/**
 * How far a tab's list must keep its ends clear of the glass header above the
 * tabs and the tab bar below. Each tab measures its own safe area
 * (`NativeTabsNavigator` gives every tab a safe-area provider), which UIKit
 * extends by the navigation bar and the tab bar.
 */
export function useTabContentInsets(): { readonly top: number; readonly bottom: number } {
  const insets = useSafeAreaInsets();
  return { top: insets.top, bottom: insets.bottom };
}
