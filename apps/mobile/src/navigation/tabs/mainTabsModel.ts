// Pure, react-native-free description of the app's main tabs. `Stack.tsx` and
// the native tab navigator build the tab bar from this table, and the route
// config test asserts over it, so labels, icons, order and links cannot drift.

/** The main tabs, in tab-bar order. The order is a user decision (round 2). */
export const MAIN_TAB_NAMES = ["Chats", "Tasks", "PullRequests", "Usage", "Settings"] as const;

export type MainTabName = (typeof MAIN_TAB_NAMES)[number];

/**
 * A tab bar icon: an SF Symbol, or one of the app's template images (tinted
 * like a symbol), named here and resolved to its asset in `MainTabs.tsx` so
 * this table stays free of React Native.
 */
export type MainTabIcon =
  | { readonly type: "sfSymbol"; readonly name: string }
  | { readonly type: "template"; readonly asset: "pullRequest" };

export interface MainTabDescriptor {
  /** Linking path relative to the app root; Chats is the root itself. */
  readonly linking: string;
  /** The tab's name for VoiceOver; the bar shows icons only. */
  readonly label: string;
  /** The tab's large title at the top of its screen. */
  readonly title: string;
  /** The tab bar icon, and the one it shows while selected (the same when absent). */
  readonly icon: MainTabIcon;
  readonly selectedIcon?: MainTabIcon;
}

const symbol = (name: string): MainTabIcon => ({ type: "sfSymbol", name });

// Icons follow t3code's phone tab bar (`navigation-tabs.ts`, `WorkspaceNativeTabs.ios.tsx`):
// `text.bubble`, its pull request template image and `chart.bar.xaxis`, with `gearshape`.
// Tasks has no t3code counterpart: `checklist` is a line glyph of the same weight.
export const MAIN_TABS = {
  Chats: {
    linking: "",
    label: "Chats",
    title: "Chats",
    icon: symbol("text.bubble"),
    selectedIcon: symbol("text.bubble.fill"),
  },
  Tasks: {
    linking: "tasks",
    label: "Tasks",
    title: "Tasks",
    icon: symbol("checklist"),
  },
  PullRequests: {
    linking: "pull-requests",
    label: "Pull requests",
    title: "Pull requests",
    icon: { type: "template", asset: "pullRequest" },
  },
  Usage: {
    linking: "usage",
    label: "Usage",
    title: "Usage",
    icon: symbol("chart.bar.xaxis"),
  },
  Settings: {
    linking: "settings",
    label: "Settings",
    title: "Settings",
    icon: symbol("gearshape"),
    selectedIcon: symbol("gearshape.fill"),
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
