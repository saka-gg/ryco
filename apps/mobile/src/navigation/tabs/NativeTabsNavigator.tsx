import {
  createNavigatorFactory,
  createScreenFactory,
  type DefaultNavigatorOptions,
  type EventArg,
  type NavigationProp,
  type NavigatorTypeBagBase,
  type ParamListBase,
  type StaticConfig,
  type TabActionHelpers,
  TabActions,
  type TabNavigationState,
  TabRouter,
  type TabRouterOptions,
  type TypedNavigator,
  useNavigation,
  useNavigationBuilder,
} from "@react-navigation/native";
import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { useLayoutEffect, useState } from "react";
import { Platform, type NativeSyntheticEvent } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  Tabs,
  type PlatformIconAndroid,
  type PlatformIconIOS,
  type TabSelectedEvent,
  type TabSelectionRejectedEvent,
} from "react-native-screens";

import { useThemeColor } from "../../lib/useThemeColor";

/**
 * The header of the stack screen that hosts the tabs, as the tab in front
 * wants it. Only these keys are forwarded, and every one of them is reset on a
 * tab switch, so one tab's buttons never linger over the next tab.
 */
export type NativeTabStackHeaderOptions = Pick<
  NativeStackNavigationOptions,
  "title" | "headerTitle" | "headerLeft" | "headerRight" | "headerShown"
>;

const FORWARDED_HEADER_RESET: Record<keyof NativeTabStackHeaderOptions, undefined> = {
  title: undefined,
  headerTitle: undefined,
  headerLeft: undefined,
  headerRight: undefined,
  headerShown: undefined,
};

export interface NativeTabOptions {
  /** The tab's name for VoiceOver; the bar shows icons only. */
  readonly tabBarLabel?: string;
  /** The iOS tab bar item's icon, and its selected icon (the same when absent). */
  readonly iosIcon?: PlatformIconIOS;
  readonly iosSelectedIcon?: PlatformIconIOS;
  /** The Android item's icon: only image sources, since SF Symbols are iOS only. */
  readonly androidIcon?: PlatformIconAndroid;
  readonly badgeValue?: string;
  /** Header of the hosting stack screen while this tab is in front. */
  readonly stackHeader?: NativeTabStackHeaderOptions;
}

export type NativeTabsEventMap = {
  /** The person tapped the tab's item, also when it is already selected. */
  tabPress: { data: { readonly repeated: boolean }; canPreventDefault: true };
};

type NativeTabsNavigatorProps = DefaultNavigatorOptions<
  ParamListBase,
  string | undefined,
  TabNavigationState<ParamListBase>,
  NativeTabOptions,
  NativeTabsEventMap,
  NavigationProp<ParamListBase>
> &
  TabRouterOptions;

/**
 * A tab navigator drawn by the platform: `UITabBarController` on iOS (Liquid
 * Glass from iOS 26) and the Material bottom navigation on Android, through
 * react-native-screens' `Tabs`.
 *
 * It is meant to be the root screen of a native stack: each tab is a list,
 * details push on the stack above the tabs, and the stack screen's header
 * shows what the tab in front asks for (`stackHeader`). The native controller
 * keeps every visited tab's view alive, so a tab comes back at the scroll
 * position it was left at. A tab mounts on its first visit.
 */
function NativeTabsNavigator({
  id,
  initialRouteName,
  backBehavior,
  UNSTABLE_routeNamesChangeBehavior,
  children,
  layout,
  screenListeners,
  screenOptions,
  screenLayout,
  UNSTABLE_router,
}: NativeTabsNavigatorProps) {
  const { state, descriptors, navigation, NavigationContent } = useNavigationBuilder<
    TabNavigationState<ParamListBase>,
    TabRouterOptions,
    TabActionHelpers<ParamListBase>,
    NativeTabOptions,
    NativeTabsEventMap
  >(TabRouter, {
    id,
    initialRouteName,
    backBehavior,
    UNSTABLE_routeNamesChangeBehavior,
    children,
    layout,
    screenListeners,
    screenOptions,
    screenLayout,
    UNSTABLE_router,
  });
  // The stack route that hosts the tabs.
  const hostNavigation = useNavigation();
  // The selected item's tint, as t3code's bar: the theme's primary (white in dark, black in light).
  const tintColor = useThemeColor("--color-primary");
  const focusedRoute = state.routes[state.index]!;
  const focusedHeader = descriptors[focusedRoute.key]?.options.stackHeader;

  useLayoutEffect(() => {
    hostNavigation.setOptions({ ...FORWARDED_HEADER_RESET, ...focusedHeader });
  }, [focusedHeader, hostNavigation]);

  // Native and JS each own a selection; the provenance counter lets the native
  // side drop a request built on a selection it has already moved past.
  const [provenance, setProvenance] = useState(0);
  // A tab mounts when it is first shown, then stays (the native controller
  // keeps its view and scroll position).
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set([focusedRoute.key]));
  if (!visited.has(focusedRoute.key)) {
    setVisited(new Set(visited).add(focusedRoute.key));
  }

  const onTabSelected = ({ nativeEvent }: NativeSyntheticEvent<TabSelectedEvent>) => {
    setProvenance(nativeEvent.provenance);
    if (nativeEvent.actionOrigin === "programmatic-js") return;
    const route = state.routes.find((candidate) => candidate.key === nativeEvent.selectedScreenKey);
    if (route === undefined) return;
    const event = navigation.emit({
      type: "tabPress",
      target: route.key,
      data: { repeated: nativeEvent.isRepeated },
      canPreventDefault: true,
    }) as EventArg<"tabPress", true, { readonly repeated: boolean }>;
    if (event.defaultPrevented || nativeEvent.isRepeated) return;
    navigation.dispatch({ ...TabActions.jumpTo(route.name), target: state.key });
  };

  return (
    <NavigationContent>
      <Tabs.Host
        navStateRequest={{ selectedScreenKey: focusedRoute.key, baseProvenance: provenance }}
        onTabSelected={onTabSelected}
        onTabSelectionRejected={({
          nativeEvent,
        }: NativeSyntheticEvent<TabSelectionRejectedEvent>) =>
          setProvenance(nativeEvent.provenance)
        }
        colorScheme="inherit"
        ios={{
          // A tab bar on every width: iPad shows it floating at the top.
          tabBarControllerMode: "tabBar",
          tabBarMinimizeBehavior: "never",
          tabBarTintColor: tintColor,
        }}
      >
        {state.routes.map((route) => {
          const descriptor = descriptors[route.key]!;
          const options = descriptor.options;
          const label = options.tabBarLabel ?? route.name;
          return (
            <Tabs.Screen
              key={route.key}
              screenKey={route.key}
              // Icons only (a user decision); the label stays for VoiceOver.
              title=""
              accessibilityLabel={label}
              badgeValue={options.badgeValue}
              tabBarItemAccessibilityLabel={label}
              tabBarItemTestID={`tab-${route.name}`}
              specialEffects={{ repeatedTabSelection: { popToRoot: true, scrollToTop: true } }}
              android={
                Platform.OS === "android" && options.androidIcon
                  ? { icon: options.androidIcon }
                  : undefined
              }
              ios={
                Platform.OS === "ios"
                  ? {
                      icon: options.iosIcon,
                      selectedIcon: options.iosSelectedIcon,
                      // Each tab's scroll view adjusts for the header and tab bar itself.
                      overrideScrollViewContentInsetAdjustmentBehavior: false,
                    }
                  : undefined
              }
            >
              {/* Its own provider, so the tab's insets include the header and the tab bar. */}
              {visited.has(route.key) ? (
                <SafeAreaProvider style={TAB_CONTENT_STYLE}>{descriptor.render()}</SafeAreaProvider>
              ) : null}
            </Tabs.Screen>
          );
        })}
      </Tabs.Host>
    </NavigationContent>
  );
}

const TAB_CONTENT_STYLE = { flex: 1 } as const;

export type NativeTabsTypeBag<
  ParamList extends ParamListBase = ParamListBase,
  NavigatorID extends string | undefined = string | undefined,
> = {
  ParamList: ParamList;
  NavigatorID: NavigatorID;
  State: TabNavigationState<ParamList>;
  ScreenOptions: NativeTabOptions;
  EventMap: NativeTabsEventMap;
  NavigationList: {
    [RouteName in keyof ParamList]: NavigationProp<
      ParamList,
      RouteName,
      NavigatorID,
      TabNavigationState<ParamList>,
      NativeTabOptions,
      NativeTabsEventMap
    > &
      TabActionHelpers<ParamList>;
  };
  Navigator: typeof NativeTabsNavigator;
};

export function createNativeTabsNavigator<
  const ParamList extends ParamListBase,
  const NavigatorID extends string | undefined = string | undefined,
  const TypeBag extends NavigatorTypeBagBase = NativeTabsTypeBag<ParamList, NavigatorID>,
  const Config extends StaticConfig<TypeBag> = StaticConfig<TypeBag>,
>(config?: Config): TypedNavigator<TypeBag, Config> {
  return createNavigatorFactory(NativeTabsNavigator)(config);
}

export const createNativeTabScreen = createScreenFactory<NativeTabsTypeBag>();
