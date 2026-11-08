// Pure, react-native-free description of the app's main tabs. `Stack.tsx` and
// the native tab navigator build the tab bar from this table, and the route
// config test asserts over it, so labels, icons, order and links cannot drift.

/** The main tabs, in tab-bar order. The order is a user decision (round 2). */
export const MAIN_TAB_NAMES = ["Chats", "Tasks", "PullRequests", "Usage", "Settings"] as const;

export type MainTabName = (typeof MAIN_TAB_NAMES)[number];

export interface MainTabDescriptor {
  /** Linking path relative to the app root; Chats is the root itself. */
  readonly linking: string;
  /** The tab's name for VoiceOver; the bar shows icons only. */
  readonly label: string;
  /** The tab's large title at the top of its screen. */
  readonly title: string;
  /** SF Symbol shown in the iOS tab bar, and when selected. */
  readonly sfSymbol: string;
  readonly selectedSfSymbol: string;
}

export const MAIN_TABS = {
  Chats: {
    linking: "",
    label: "Chats",
    title: "Chats",
    sfSymbol: "bubble.left.and.text.bubble.right",
    selectedSfSymbol: "bubble.left.and.text.bubble.right.fill",
  },
  Tasks: {
    linking: "tasks",
    label: "Tasks",
    title: "Tasks",
    sfSymbol: "checkmark.circle",
    selectedSfSymbol: "checkmark.circle.fill",
  },
  PullRequests: {
    linking: "pull-requests",
    label: "Pull requests",
    title: "Pull requests",
    sfSymbol: "arrow.triangle.pull",
    selectedSfSymbol: "arrow.triangle.pull",
  },
  Usage: {
    linking: "usage",
    label: "Usage",
    title: "Usage",
    sfSymbol: "chart.bar",
    selectedSfSymbol: "chart.bar.fill",
  },
  Settings: {
    linking: "settings",
    label: "Settings",
    title: "Settings",
    sfSymbol: "gearshape",
    selectedSfSymbol: "gearshape.fill",
  },
} as const satisfies Record<MainTabName, MainTabDescriptor>;

export function isMainTabName(value: string): value is MainTabName {
  return (MAIN_TAB_NAMES as readonly string[]).includes(value);
}

/**
 * Old links that named a screen which is a tab now. Widgets and notifications
 * written by earlier builds still carry them, so they keep opening the same
 * screen: Statistics moved out of Settings into the Usage tab.
 */
const LEGACY_PATH_PREFIXES: ReadonlyArray<readonly [from: string, to: string]> = [
  ["settings/statistics", MAIN_TABS.Usage.linking],
];

/** Rewrite a link path an earlier build wrote to the path that opens the same screen now. */
export function rewriteLegacyTabPath(path: string): string {
  const leadingSlash = path.startsWith("/");
  const bare = leadingSlash ? path.slice(1) : path;
  for (const [from, to] of LEGACY_PATH_PREFIXES) {
    if (bare === from || bare.startsWith(`${from}?`) || bare.startsWith(`${from}/`)) {
      const rewritten = `${to}${bare.slice(from.length)}`;
      return leadingSlash ? `/${rewritten}` : rewritten;
    }
  }
  return path;
}
