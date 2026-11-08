import { StackActions, type NavigationProp, type ParamListBase } from "@react-navigation/native";

import type { MainTabName } from "./mainTabsModel";

/**
 * Bring one of the main tabs to the front from anywhere: screens above the
 * tabs close (a pop back to them, never a second copy of the tabs), and the
 * tab shows with its own scroll position.
 */
export function openMainTab(
  navigation: Pick<NavigationProp<ParamListBase>, "dispatch">,
  tab: MainTabName,
  params?: object,
): void {
  navigation.dispatch(StackActions.popTo("Home", { screen: tab, params }));
}
