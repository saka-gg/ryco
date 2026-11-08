/** `StackActions.replace("Home")`, spelled out so this module stays free of React Native. */
const REPLACE_WITH_HOME = { type: "REPLACE", payload: { name: "Home" } } as const;

/** The part of a navigation object closing a screen needs (React Navigation's own). */
export interface ClosableNavigation {
  canGoBack(): boolean;
  goBack(): void;
  dispatch(action: typeof REPLACE_WITH_HOME): void;
}

/**
 * Close a screen: back to where the person came from, or, when a link opened it cold with
 * nothing beneath, to the tabs (Chats) in its place.
 */
export function goBackOrHome(navigation: ClosableNavigation): void {
  if (navigation.canGoBack()) {
    navigation.goBack();
    return;
  }
  navigation.dispatch(REPLACE_WITH_HOME);
}
