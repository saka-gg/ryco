// Pure, react-native-free description of the MVP navigation tree. This is the
// single source of truth the native `Stack.tsx` builds its screen options from
// AND the route-config test asserts over — kept import-clean so it stays
// node-testable (react-native / react-navigation ship untranspiled Flow syntax
// and cannot load in the vp/node test env).

export type RoutePresentation = "card" | "formSheet" | "fullScreenModal";
export type HeaderPreset = "glass" | "solid" | "sheet-solid" | "none";
export type HeaderAction = "back" | "close" | "none";

export interface RoutePlatformPresentation {
  readonly presentation: RoutePresentation;
  readonly sheetAllowedDetents?: readonly number[];
  readonly sheetGrabberVisible?: boolean;
  readonly headerShown?: boolean;
}

export interface MvpRouteDescriptor {
  /** Linking path relative to the app root (the flat deep-link URL). */
  readonly linking: string;
  /** True when the route floats over the workspace and must not enter the
   *  adaptive-layout pathname (WORKSPACE_OVERLAY_ROUTES). */
  readonly overlay: boolean;
  readonly headerPreset: HeaderPreset;
  /** Explicit navigation affordance rendered in the native header. Headerless
   *  surfaces provide their dismissal action in content instead. */
  readonly headerAction: HeaderAction;
  readonly ios: RoutePlatformPresentation;
  readonly android: RoutePlatformPresentation;
}

const THREAD = "threads/:environmentId/:threadId";
const PROJECT = "projects/:environmentId/:projectId";

// Flat root routes (Thread lives here, NOT in a nested navigator — required for
// the iOS-26 shared-header morph). Order is the source order for the tree.
export const MVP_ROOT_ROUTES = {
  Access: {
    linking: "account/access",
    overlay: false,
    headerPreset: "none",
    headerAction: "none",
    ios: { presentation: "card" },
    android: { presentation: "card" },
  },
  Home: {
    linking: "",
    overlay: false,
    headerPreset: "glass",
    headerAction: "none",
    ios: { presentation: "card" },
    android: { presentation: "card" },
  },
  AddProject: {
    linking: "projects/new",
    overlay: true,
    headerPreset: "sheet-solid",
    headerAction: "close",
    ios: {
      presentation: "formSheet",
      sheetAllowedDetents: [0.7, 0.95],
      sheetGrabberVisible: true,
    },
    android: { presentation: "card" },
  },
  Project: {
    linking: PROJECT,
    overlay: false,
    headerPreset: "glass",
    headerAction: "back",
    ios: { presentation: "card" },
    android: { presentation: "card" },
  },
  ProjectSourceControl: {
    linking: `${PROJECT}/source-control/:worktreeId?`,
    overlay: false,
    headerPreset: "glass",
    headerAction: "back",
    ios: { presentation: "card" },
    android: { presentation: "card" },
  },
  NewTask: {
    linking: "tasks/new",
    overlay: true,
    headerPreset: "sheet-solid",
    headerAction: "close",
    ios: {
      presentation: "formSheet",
      sheetAllowedDetents: [0.62, 0.94],
      sheetGrabberVisible: true,
    },
    android: { presentation: "card" },
  },
  Thread: {
    linking: THREAD,
    overlay: false,
    headerPreset: "glass",
    headerAction: "back",
    ios: { presentation: "card" },
    android: { presentation: "card" },
  },
  ThreadReview: {
    linking: `${THREAD}/review`,
    overlay: false,
    headerPreset: "solid",
    headerAction: "back",
    ios: { presentation: "card" },
    android: { presentation: "card" },
  },
  ThreadReviewComment: {
    linking: `${THREAD}/review-comment`,
    overlay: true,
    headerPreset: "none",
    headerAction: "none",
    // Android cannot host the keyboard-driven comment composer inside a formSheet.
    ios: {
      presentation: "formSheet",
      sheetAllowedDetents: [0.55, 0.92],
      sheetGrabberVisible: true,
    },
    android: { presentation: "fullScreenModal", sheetGrabberVisible: false },
  },
  // Read-only workspace browser for the thread's checkout. A card rather than a
  // sheet on both platforms: browsing is a destination the user drills into and
  // backs out of, and the file screen below pushes on top of it.
  ThreadFiles: {
    linking: `${THREAD}/files`,
    overlay: false,
    headerPreset: "glass",
    headerAction: "back",
    ios: { presentation: "card" },
    android: { presentation: "card" },
  },
  /**
   * One file's preview. `:path*` is a SEGMENT WILDCARD: a workspace-relative
   * path contains slashes, so it cannot ride in a single `:path` param, and
   * navigation hands the segments back as an already-decoded array the screen
   * rejoins. `?line=` is read off the same params.
   *
   * A solid header, unlike the browser's glass: the source view scrolls
   * horizontally as well as vertically, and code sliding under a translucent
   * header is unreadable.
   */
  ThreadFile: {
    linking: `${THREAD}/files/:path*`,
    overlay: false,
    headerPreset: "solid",
    headerAction: "back",
    ios: { presentation: "card" },
    android: { presentation: "card" },
  },
  Connections: {
    linking: "connections",
    overlay: true,
    headerPreset: "none",
    headerAction: "none",
    // Widened from [0.55, 0.7]: the sheet now carries two labeled sections —
    // direct saved devices and hosted Hub nodes — rather than one list.
    ios: {
      presentation: "formSheet",
      sheetAllowedDetents: [0.6, 0.95],
      sheetGrabberVisible: true,
    },
    android: { presentation: "card", headerShown: false },
  },
  ConnectionsNew: {
    // Deliberate divergence from upstream's formSheet: a card per the spec table.
    linking: "connections/new",
    overlay: true,
    headerPreset: "sheet-solid",
    headerAction: "back",
    ios: { presentation: "card" },
    android: { presentation: "card" },
  },
  SettingsSheet: {
    linking: "settings",
    // Floats over the workspace: opening Settings from the Home header must not
    // change which thread the workspace is on (see WORKSPACE_OVERLAY_ROUTES).
    overlay: true,
    headerPreset: "none",
    headerAction: "none",
    // Start compact; the native grabber expands longer settings screens.
    ios: {
      presentation: "formSheet",
      sheetAllowedDetents: [0.78, 0.94],
      sheetGrabberVisible: true,
    },
    android: { presentation: "card" },
  },
  NotFound: {
    // Deep-link catch-all — the one sanctioned route not in the spec's table.
    linking: "*",
    overlay: false,
    headerPreset: "none",
    headerAction: "none",
    ios: { presentation: "card" },
    android: { presentation: "card" },
  },
} as const satisfies Record<string, MvpRouteDescriptor>;

export type MvpRootRouteName = keyof typeof MVP_ROOT_ROUTES;

/**
 * A nested settings route.
 *
 * The per-platform presentation is REQUIRED rather than inferred. Every route in
 * this stack is a push today, and writing that down is what makes the next route
 * that should not be one an explicit decision instead of a default nobody
 * noticed — the same reason `MvpRouteDescriptor` carries both platforms.
 */
export interface MvpSettingsRouteDescriptor {
  readonly linking: string;
  /** Settings itself installs a parent-stack close action; every pushed child
   *  has an explicit Back button, including non-swipeable security screens. */
  readonly headerAction: "back" | "none";
  readonly ios: RoutePlatformPresentation;
  readonly android: RoutePlatformPresentation;
}

/** A push inside the settings stack, which is what every route here is. */
const SETTINGS_PUSH = {
  ios: { presentation: "card" },
  android: { presentation: "card" },
} as const satisfies Pick<MvpSettingsRouteDescriptor, "ios" | "android">;

// Nested routes inside the Settings sheet.
export const MVP_SETTINGS_SHEET_ROUTES = {
  Settings: { linking: "", headerAction: "none", ...SETTINGS_PUSH },
  SettingsHub: { linking: "hub", headerAction: "back", ...SETTINGS_PUSH },
  SettingsWorkspace: { linking: "workspace", headerAction: "back", ...SETTINGS_PUSH },
  SettingsStatistics: { linking: "statistics", headerAction: "back", ...SETTINGS_PUSH },
  SettingsInbox: { linking: "inbox", headerAction: "back", ...SETTINGS_PUSH },
  // Hosted Hub account. Account management stays nested; voluntary sign-in
  // opens the full-screen root Access route rather than a dismissible sheet.
  SettingsAccount: { linking: "account", headerAction: "back", ...SETTINGS_PUSH },
  /**
   * The `docs/relay-e2ee-protocol.md` §13.1.1 security surface: the persistent
   * indication that this device has verified no node on this Hub, the channel's
   * §12.2 label, the §13.2.1 resolutions, and the §11.4 local diagnostics.
   *
   * Nested for the same reason `SettingsAccount` is, and a PUSH on both
   * platforms deliberately: §13.1.1 requires an indication that "MUST NOT be
   * presented as a transient banner that dismisses into a verified-looking
   * state", and a sheet the owner swipes away is the closest thing this
   * navigator has to one.
   */
  SettingsNodeSecurity: {
    linking: "node-security/:environmentId/:nodeId",
    headerAction: "back",
    ...SETTINGS_PUSH,
  },
  /**
   * The §13.2 ceremony and §13.3's re-verification UI: the enrollment
   * fingerprint, the §13.4 safety number, and the one action that mints an owner
   * verification decision. A push on both platforms so the comparison cannot be
   * dismissed by a downward swipe mid-ceremony.
   */
  SettingsNodeVerification: {
    linking: "node-verification/:environmentId/:nodeId",
    headerAction: "back",
    ...SETTINGS_PUSH,
  },
  SettingsAppearance: { linking: "appearance", headerAction: "back", ...SETTINGS_PUSH },
  SettingsClientStorage: {
    linking: "client-storage",
    headerAction: "back",
    ...SETTINGS_PUSH,
  },
  SettingsAbout: { linking: "about", headerAction: "back", ...SETTINGS_PUSH },
} as const satisfies Record<string, MvpSettingsRouteDescriptor>;

export type MvpSettingsRouteName = keyof typeof MVP_SETTINGS_SHEET_ROUTES;

export const WORKSPACE_OVERLAY_ROUTE_NAMES: readonly MvpRootRouteName[] = (
  Object.keys(MVP_ROOT_ROUTES) as MvpRootRouteName[]
).filter((name) => MVP_ROOT_ROUTES[name].overlay);
