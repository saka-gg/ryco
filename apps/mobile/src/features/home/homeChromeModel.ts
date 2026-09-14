import type { HomeMode } from "./homeMode";

// Pure description of the Home screen's chrome — title, both header sides, and
// the bottom search toolbar. `HomeScreen.tsx` is layout only; every decision
// about what appears and what it is called lives here so it can be tested
// without a React Native renderer (program status §1.1).

export const HOME_MODE_TITLE: Readonly<Record<HomeMode, string>> = {
  inbox: "Inbox",
  projects: "Projects",
};

export const HOME_TOOLBAR_HEIGHT = 56;
export const HOME_TOOLBAR_INSET = 12;

/** Safe-area, toolbar, and breathing room for the last list row. */
export const HOME_LIST_PADDING_BOTTOM = 124;

export type HomeChromeButtonId = "home-mark" | "search" | "settings" | "new-task";

export interface HomeChromeButton {
  readonly id: HomeChromeButtonId;
  readonly accessibilityLabel: string;
}

export interface HomeChromeModel {
  readonly title: string;
  /**
   * The mark is a *mode switch*, not a route push — it dispatches
   * `select-mode` and never opens another navigation layer.
   */
  readonly headerLeft: HomeChromeButton;
  readonly headerLeftTargetMode: HomeMode;
  readonly headerRight: readonly [HomeChromeButton];
  readonly newTask: HomeChromeButton;
  readonly search: HomeChromeButton;
}

export function buildHomeChromeModel(input: { readonly mode: HomeMode }): HomeChromeModel {
  const title = HOME_MODE_TITLE[input.mode];

  return {
    title,
    // Always Inbox, from every mode. The mark is the app's "take me home"
    // affordance, so its target — and therefore its label — stays constant
    // rather than changing under the user.
    headerLeft: { id: "home-mark", accessibilityLabel: "Open Inbox" },
    headerLeftTargetMode: "inbox",
    headerRight: [{ id: "settings", accessibilityLabel: "Settings" }],
    search: { id: "search", accessibilityLabel: `Search ${title}` },
    // Shown in every mode, matching the reach of the header "+" it replaces.
    newTask: { id: "new-task", accessibilityLabel: "New Task" },
  };
}
