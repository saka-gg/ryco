import { HomeRouteScreen } from "../../features/home/HomeRouteScreen";
import {
  PullRequestsTabScreen,
  SettingsTabScreen,
  TasksTabScreen,
  UsageTabScreen,
} from "../lazyRouteScreens";
import { MAIN_TABS, type MainTabName } from "./mainTabsModel";
import {
  createNativeTabScreen,
  createNativeTabsNavigator,
  type NativeTabOptions,
} from "./NativeTabsNavigator";

function tabOptions(name: MainTabName): NativeTabOptions {
  const tab = MAIN_TABS[name];
  return {
    tabBarLabel: tab.label,
    sfSymbol: tab.sfSymbol,
    selectedSfSymbol: tab.selectedSfSymbol,
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
      options: tabOptions("PullRequests"),
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
