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
  /**
   * The main tabs (`tabs/mainTabsModel.ts`): Chats, Tasks, PRs, Usage and
   * Settings. Every other screen pushes or floats above them.
   */
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
  /** Switch the checkout's branch or create one. */
  ProjectBranches: {
    linking: `${PROJECT}/git/branches/:worktreeId?`,
    overlay: true,
    headerPreset: "sheet-solid",
    headerAction: "close",
    ios: { presentation: "formSheet", sheetAllowedDetents: [0.6, 0.95], sheetGrabberVisible: true },
    android: { presentation: "card" },
  },
  /** Commit every change with an own message, optionally pushing and opening a PR. */
  ProjectCommit: {
    linking: `${PROJECT}/git/commit/:worktreeId?`,
    overlay: true,
    headerPreset: "sheet-solid",
    headerAction: "close",
    ios: { presentation: "formSheet", sheetAllowedDetents: [0.7, 0.95], sheetGrabberVisible: true },
    android: { presentation: "card" },
  },
  /**
   * Stage and unstage files and hunks, and commit exactly the staged ones. A
   * solid header: diff rows scroll sideways under it.
   */
  ProjectChanges: {
    linking: `${PROJECT}/git/changes/:worktreeId?`,
    overlay: false,
    headerPreset: "solid",
    headerAction: "back",
    ios: { presentation: "card" },
    android: { presentation: "card" },
  },
  /** Compare the checkout with another ref; long-press a line for blame. */
  ProjectCompare: {
    linking: `${PROJECT}/git/compare/:worktreeId?`,
    overlay: false,
    headerPreset: "solid",
    headerAction: "back",
    ios: { presentation: "card" },
    android: { presentation: "card" },
  },
  /** Create the repository on a host and push the checkout there. */
  ProjectPublish: {
    linking: `${PROJECT}/git/publish/:worktreeId?`,
    overlay: true,
    headerPreset: "sheet-solid",
    headerAction: "close",
    ios: { presentation: "formSheet", sheetAllowedDetents: [0.8, 0.95], sheetGrabberVisible: true },
    android: { presentation: "card" },
  },
  /** The checkout's and the project's notes (the desktop's Notes pane). */
  ProjectNotes: {
    linking: `${PROJECT}/notes/:worktreeId?`,
    overlay: false,
    headerPreset: "solid",
    headerAction: "back",
    ios: { presentation: "card" },
    android: { presentation: "card" },
  },
  /** Issues, Actions runs and Jira items of a project's repository. */
  ProjectExplorer: {
    linking: `${PROJECT}/explorer`,
    overlay: false,
    headerPreset: "glass",
    headerAction: "back",
    ios: { presentation: "card" },
    android: { presentation: "card" },
  },
  /** A new issue; before ProjectIssue so `issues/new` is not read as a number. */
  ProjectNewIssue: {
    linking: `${PROJECT}/issues/new`,
    overlay: true,
    headerPreset: "sheet-solid",
    headerAction: "close",
    ios: { presentation: "formSheet", sheetAllowedDetents: [0.8, 0.95], sheetGrabberVisible: true },
    android: { presentation: "card" },
  },
  ProjectIssue: {
    linking: `${PROJECT}/issues/:number`,
    overlay: false,
    headerPreset: "glass",
    headerAction: "back",
    ios: { presentation: "card" },
    android: { presentation: "card" },
  },
  /** One Actions run: jobs, steps and logs. */
  ProjectWorkflowRun: {
    linking: `${PROJECT}/actions/:runId`,
    overlay: false,
    headerPreset: "glass",
    headerAction: "back",
    ios: { presentation: "card" },
    android: { presentation: "card" },
  },
  ProjectWorkItem: {
    linking: `${PROJECT}/work-items/:key`,
    overlay: false,
    headerPreset: "glass",
    headerAction: "back",
    ios: { presentation: "card" },
    android: { presentation: "card" },
  },
  /** One repository's pull requests: the list a project's checkout reads through. */
  ProjectPullRequests: {
    linking: `${PROJECT}/pull-requests`,
    overlay: false,
    headerPreset: "glass",
    headerAction: "back",
    ios: { presentation: "card" },
    android: { presentation: "card" },
  },
  /** One pull request: summary, conversation, checks and files. */
  ProjectPullRequest: {
    linking: `${PROJECT}/pull-requests/:number`,
    overlay: false,
    headerPreset: "glass",
    headerAction: "back",
    ios: { presentation: "card" },
    android: { presentation: "card" },
  },
  /**
   * One file's diff in a pull request. `:path*` is a segment wildcard like
   * ThreadFile's; a solid header, because the diff scrolls horizontally too.
   */
  ProjectPullRequestFile: {
    linking: `${PROJECT}/pull-requests/:number/files/:path*`,
    overlay: false,
    headerPreset: "solid",
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
  /**
   * One of the user's Tasks (a machine's to-do list): title, notes, priority,
   * due day, project, links, files and its chats. A sheet that opens tall
   * enough for the notes and expands for the rest.
   */
  TaskDetail: {
    linking: "todo/:environmentId/:taskId",
    overlay: true,
    headerPreset: "sheet-solid",
    headerAction: "close",
    ios: {
      presentation: "formSheet",
      sheetAllowedDetents: [0.7, 0.94],
      sheetGrabberVisible: true,
    },
    android: { presentation: "card" },
  },
  /** Every schedule (scheduled task) the phone reaches, by project; the Tasks tab opens it. */
  Scheduled: {
    linking: "todo/scheduled",
    overlay: false,
    headerPreset: "glass",
    headerAction: "back",
    ios: { presentation: "card" },
    android: { presentation: "card" },
  },
  /** One schedule: approvals, when it runs, what it does, its actions and run history. */
  ScheduleDetail: {
    linking: "todo/scheduled/:environmentId/:projectId/:automationId",
    overlay: false,
    headerPreset: "glass",
    headerAction: "back",
    ios: { presentation: "card" },
    android: { presentation: "card" },
  },
  /** The schedule editor: a new schedule, a change, or an expired proposal proposed again. */
  ScheduleEditor: {
    linking: "todo/schedule-editor/:environmentId/:projectId/:mode/:automationId?",
    overlay: true,
    headerPreset: "sheet-solid",
    headerAction: "close",
    ios: {
      presentation: "formSheet",
      sheetAllowedDetents: [0.94],
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
  /**
   * A plain editor for one workspace file (`projects.writeFile`). `:path*` is a
   * segment wildcard like ThreadFile's; a solid header holds the Save button.
   */
  ThreadFileEdit: {
    linking: `${THREAD}/edit/:path*`,
    overlay: false,
    headerPreset: "solid",
    headerAction: "back",
    ios: { presentation: "card" },
    android: { presentation: "card" },
  },
  /** Find in files across the thread's workspace (`projects.searchContent`). */
  ThreadFileSearch: {
    linking: `${THREAD}/find`,
    overlay: false,
    headerPreset: "solid",
    headerAction: "back",
    ios: { presentation: "card" },
    android: { presentation: "card" },
  },
  /** Run a project script or a one-off command in a new terminal of the thread. */
  ThreadScripts: {
    linking: `${THREAD}/scripts`,
    overlay: true,
    headerPreset: "sheet-solid",
    headerAction: "close",
    ios: { presentation: "formSheet", sheetAllowedDetents: [0.6, 0.95], sheetGrabberVisible: true },
    android: { presentation: "card" },
  },
  /** Pick, boot and attach a simulator or emulator; install and launch apps; record. */
  ThreadDevices: {
    linking: `${THREAD}/devices`,
    overlay: true,
    headerPreset: "sheet-solid",
    headerAction: "close",
    ios: { presentation: "formSheet", sheetAllowedDetents: [0.6, 0.95], sheetGrabberVisible: true },
    android: { presentation: "card" },
  },
  /** The dev servers the thread started: preview or stop them, or preview any address. */
  ThreadServers: {
    linking: `${THREAD}/servers`,
    overlay: true,
    headerPreset: "sheet-solid",
    headerAction: "close",
    ios: { presentation: "formSheet", sheetAllowedDetents: [0.6, 0.95], sheetGrabberVisible: true },
    android: { presentation: "card" },
  },
  /**
   * A page in the machine's browser, shown as a refreshed still with tap, scroll
   * and typing. A solid header: the page must not slide under it.
   */
  ThreadBrowser: {
    linking: `${THREAD}/preview`,
    overlay: false,
    headerPreset: "solid",
    headerAction: "back",
    ios: { presentation: "card" },
    android: { presentation: "card" },
  },
  /**
   * A thread's terminal. A card with a solid header on both platforms: the
   * terminal owns the viewport below it, and output must never slide under a
   * translucent header. Regular-width windows show it in the workspace
   * inspector instead (see ThreadWorkspaceLayout).
   */
  ThreadTerminal: {
    linking: `${THREAD}/terminal`,
    overlay: false,
    headerPreset: "solid",
    headerAction: "back",
    ios: { presentation: "card" },
    android: { presentation: "card" },
  },
  /**
   * The simulator or emulator the thread's agent uses, full screen with no header: the device
   * screen owns the viewport, and its own controls bar closes it.
   */
  ThreadDevice: {
    linking: `${THREAD}/device`,
    overlay: true,
    headerPreset: "none",
    headerAction: "none",
    ios: { presentation: "fullScreenModal" },
    android: { presentation: "fullScreenModal", headerShown: false },
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
  /**
   * One search across chats, message text, pull requests and tasks, opened
   * from a tab's search button. A screen of its own rather than an overlay: a
   * result pushes above it, and back returns to the results.
   */
  Search: {
    linking: "search",
    overlay: false,
    headerPreset: "none",
    headerAction: "none",
    ios: { presentation: "card" },
    android: { presentation: "card", headerShown: false },
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
 * A page of Settings, pushed above the tabs from the Settings tab.
 *
 * Each one is a push on both platforms deliberately, not a sheet:
 * `docs/relay-e2ee-protocol.md` §13.1.1 forbids an indication that "dismisses
 * into a verified-looking state", and a sheet the owner swipes away is the
 * nearest thing this navigator has to one. Writing the presentation down for
 * every page makes the next page that should not be a push an explicit
 * decision instead of a default nobody noticed.
 */
const SETTINGS_PAGE = {
  overlay: false,
  headerPreset: "sheet-solid",
  headerAction: "back",
  ios: { presentation: "card" },
  android: { presentation: "card" },
} as const satisfies Omit<MvpRouteDescriptor, "linking">;

const SETTINGS = "settings";

// The Settings tab's pages. Their links keep the `settings/…` paths they had
// when Settings was a sheet, so saved links still open them.
export const MVP_SETTINGS_ROUTES = {
  SettingsHub: { linking: `${SETTINGS}/hub`, ...SETTINGS_PAGE },
  SettingsWorkspace: { linking: `${SETTINGS}/workspace`, ...SETTINGS_PAGE },
  /** Each connected machine's provider instances; a sign-in opens a sheet of its own. */
  SettingsProviderAccounts: { linking: `${SETTINGS}/provider-accounts`, ...SETTINGS_PAGE },
  SettingsInbox: { linking: `${SETTINGS}/inbox`, ...SETTINGS_PAGE },
  /** Archived tasks across machines; Restore brings one back to Chats. */
  SettingsArchived: { linking: `${SETTINGS}/archived`, ...SETTINGS_PAGE },
  /** Thread alerts, which kinds alert, and the Live Activity. */
  SettingsNotifications: { linking: `${SETTINGS}/notifications`, ...SETTINGS_PAGE },
  // Hosted Hub account. Voluntary sign-in opens the full-screen root Access
  // route rather than a dismissible sheet.
  SettingsAccount: { linking: `${SETTINGS}/account`, ...SETTINGS_PAGE },
  /**
   * The `docs/relay-e2ee-protocol.md` §13.1.1 security surface: the persistent
   * indication that this device has verified no node on this Hub, the channel's
   * §12.2 label, the §13.2.1 resolutions, and the §11.4 local diagnostics.
   */
  SettingsNodeSecurity: {
    linking: `${SETTINGS}/node-security/:environmentId/:nodeId`,
    ...SETTINGS_PAGE,
  },
  /**
   * The §13.2 ceremony and §13.3's re-verification UI: the enrollment
   * fingerprint, the §13.4 safety number, and the one action that mints an owner
   * verification decision. A push so the comparison cannot be dismissed by a
   * downward swipe mid-ceremony.
   */
  SettingsNodeVerification: {
    linking: `${SETTINGS}/node-verification/:environmentId/:nodeId`,
    ...SETTINGS_PAGE,
  },
  /** The machines whose own settings this device may open (one goes straight to it). */
  SettingsMachines: { linking: `${SETTINGS}/machines`, ...SETTINGS_PAGE },
  /** One machine's own settings, grouped: Providers, Agents, Work, Machine. */
  SettingsMachine: { linking: `${SETTINGS}/machines/:environmentId`, ...SETTINGS_PAGE },
  SettingsMachineProviders: {
    linking: `${SETTINGS}/machines/:environmentId/providers`,
    ...SETTINGS_PAGE,
  },
  SettingsMachineProvider: {
    linking: `${SETTINGS}/machines/:environmentId/providers/:instanceId`,
    ...SETTINGS_PAGE,
  },
  SettingsMachineAgents: {
    linking: `${SETTINGS}/machines/:environmentId/agents`,
    ...SETTINGS_PAGE,
  },
  SettingsMachineWork: { linking: `${SETTINGS}/machines/:environmentId/work`, ...SETTINGS_PAGE },
  SettingsMachineUsagePrices: {
    linking: `${SETTINGS}/machines/:environmentId/usage-prices`,
    ...SETTINGS_PAGE,
  },
  SettingsMachineSystem: {
    linking: `${SETTINGS}/machines/:environmentId/machine`,
    ...SETTINGS_PAGE,
  },
  SettingsAppearance: { linking: `${SETTINGS}/appearance`, ...SETTINGS_PAGE },
  SettingsClientStorage: { linking: `${SETTINGS}/client-storage`, ...SETTINGS_PAGE },
  SettingsAbout: { linking: `${SETTINGS}/about`, ...SETTINGS_PAGE },
  SettingsDiagnostics: { linking: `${SETTINGS}/diagnostics`, ...SETTINGS_PAGE },
} as const satisfies Record<string, MvpRouteDescriptor>;

export type MvpSettingsRouteName = keyof typeof MVP_SETTINGS_ROUTES;

/** Every root route: the screens above, then the Settings tab's pages. */
export const MVP_ALL_ROOT_ROUTES = { ...MVP_ROOT_ROUTES, ...MVP_SETTINGS_ROUTES } as const;

export type MvpAnyRootRouteName = keyof typeof MVP_ALL_ROOT_ROUTES;

export const WORKSPACE_OVERLAY_ROUTE_NAMES: readonly MvpAnyRootRouteName[] = (
  Object.keys(MVP_ALL_ROOT_ROUTES) as MvpAnyRootRouteName[]
).filter((name) => MVP_ALL_ROOT_ROUTES[name].overlay);
