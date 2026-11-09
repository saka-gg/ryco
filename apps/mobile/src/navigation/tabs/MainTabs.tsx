import { HomeRouteScreen } from "../../features/home/HomeRouteScreen";
import {
  PullRequestsTabScreen,
  SettingsTabScreen,
  TasksTabScreen,
  UsageTabScreen,
} from "../lazyRouteScreens";
import type { PlatformIconIOS } from "react-native-screens";

import { MAIN_TABS, type MainTabIcon, type MainTabName } from "./mainTabsModel";
import {
  createNativeTabScreen,
  createNativeTabsNavigator,
  type NativeTabOptions,
} from "./NativeTabsNavigator";

// t3code's pull request glyph (MIT, see NOTICE.md), drawn as a template so it tints like a symbol.
const PULL_REQUEST_ICON = require("../../../assets/icons/pull-request.png");

function iosIcon(icon: MainTabIcon): PlatformIconIOS {
  return icon.type === "sfSymbol"
    ? { type: "sfSymbol", name: icon.name }
    : { type: "templateSource", templateSource: PULL_REQUEST_ICON };
}

function tabOptions(name: MainTabName): NativeTabOptions {
  const tab: {
    readonly label: string;
    readonly icon: MainTabIcon;
    readonly selectedIcon?: MainTabIcon;
  } = MAIN_TABS[name];
  return {
    tabBarLabel: tab.label,
    iosIcon: iosIcon(tab.icon),
    iosSelectedIcon: tab.selectedIcon ? iosIcon(tab.selectedIcon) : undefined,
    // The one image icon Android can draw; SF Symbols there need drawables (follow-up).
    androidIcon:
      tab.icon.type === "template"
        ? { type: "imageSource", imageSource: PULL_REQUEST_ICON }
        : undefined,
  };
}

/**
 * The main tabs, the root screen of the app's stack. Chats loads with the
 * app; every other tab loads its screen on first visit.
 */
export const MainTabs = createNativeTabsNavigator({
  initialRouteName: "Chats",
  // Android's back from another tab returns to Chats before it leaves the app.
  backBehavior: "firstRoute",
  screens: {
    Chats: createNativeTabScreen({
      screen: HomeRouteScreen,
      linking: MAIN_TABS.Chats.linking,
      options: tabOptions("Chats"),
    }),
    Tasks: createNativeTabScreen({
      screen: TasksTabScreen,
      linking: MAIN_TABS.Tasks.linking,
      options: tabOptions("Tasks"),
    }),
    PullRequests: createNativeTabScreen({
      screen: PullRequestsTabScreen,
      linking: MAIN_TABS.PullRequests.linking,
      // The PRs tab draws its own header: repository picker, search and filters.
      options: { ...tabOptions("PullRequests"), stackHeader: { headerShown: false } },
    }),
    Usage: createNativeTabScreen({
      screen: UsageTabScreen,
      linking: MAIN_TABS.Usage.linking,
      options: tabOptions("Usage"),
    }),
    Settings: createNativeTabScreen({
      screen: SettingsTabScreen,
      linking: MAIN_TABS.Settings.linking,
      options: tabOptions("Settings"),
    }),
  },
});
