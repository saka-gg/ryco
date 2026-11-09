import { SETTINGS_SECTION_TITLES } from "@ryco/client-runtime/state/settings/settingsSections";
import {
  createPathConfigForStaticNavigation,
  getPathFromState,
  NavigationState,
  StackActions,
  useNavigation,
} from "@react-navigation/native";
import {
  createNativeStackNavigator,
  createNativeStackScreen,
  type NativeStackNavigationOptions,
} from "@react-navigation/native-stack";
import {
  Dimensions,
  DynamicColorIOS,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
} from "react-native";

import { deriveLayout, deriveThreadWorkspaceInspectorPaneLayout } from "./lib/layout";
import { useResolveClassNames } from "uniwind";

import { AppText as Text } from "./components/AppText";
import { NavigationHeaderButton } from "./components/NavigationHeaderButton";
import { HardwareKeyboardCommandProvider } from "./features/keyboard/HardwareKeyboardCommandProvider";
import { ThreadWorkspaceLayout } from "./features/workspace/ThreadWorkspaceLayout";
import {
  AddProjectRouteScreen,
  ConnectionsNewRouteScreen,
  ConnectionsRouteScreen,
  E2eeNodeSecurityRouteScreen,
  E2eeNodeVerificationRouteScreen,
  HostedAccountRouteScreen,
  NativeIdentityScreen,
  NewTaskRouteScreen,
  ProjectRouteScreen,
  PullRequestFileRouteScreen,
  PullRequestRouteScreen,
  PullRequestsRouteScreen,
  ReviewCommentComposerSheet,
  ReviewSheet,
  SettingsAboutRouteScreen,
  SettingsAppearanceRouteScreen,
  SettingsClientStorageRouteScreen,
  SettingsDiagnosticsRouteScreen,
  SettingsHubRouteScreen,
  SettingsInboxRouteScreen,
  SettingsNotificationsRouteScreen,
  SettingsProviderAccountsRouteScreen,
  GlobalSearchRouteScreen,
  ArchivedThreadsRouteScreen,
  SettingsWorkspaceRouteScreen,
  ProjectNotesRouteScreen,
  ThreadScriptsRouteScreen,
  ThreadDevicesRouteScreen,
  ProjectExplorerRouteScreen,
  ProjectIssueRouteScreen,
  ProjectNewIssueRouteScreen,
  ProjectWorkflowRunRouteScreen,
  ProjectWorkItemRouteScreen,
  ThreadServersRouteScreen,
  ThreadBrowserRouteScreen,
  SourceControlBranchesRouteScreen,
  SourceControlChangesRouteScreen,
  SourceControlCommitRouteScreen,
  SourceControlCompareRouteScreen,
  SourceControlPublishRouteScreen,
  SourceControlRouteScreen,
  TaskDetailRouteScreen,
  ThreadFileEditRouteScreen,
  ScheduledRouteScreen,
  ScheduleDetailRouteScreen,
  ScheduleEditorRouteScreen,
  SettingsMachinesRouteScreen,
  SettingsMachineRouteScreen,
  SettingsMachineProvidersRouteScreen,
  SettingsMachineProviderRouteScreen,
  SettingsMachineAgentsRouteScreen,
  SettingsMachineWorkRouteScreen,
  SettingsMachineSystemRouteScreen,
  SettingsMachineUsagePricesRouteScreen,
  SettingsMachineImportRouteScreen,
  ThreadFileRouteScreen,
  ThreadFileSearchRouteScreen,
  ThreadFilesRouteScreen,
  ThreadRouteScreen,
  ThreadTerminalRouteScreen,
  ThreadDeviceRouteScreen,
} from "./navigation/lazyRouteScreens";
import {
  MVP_ALL_ROOT_ROUTES,
  MVP_ROOT_ROUTES,
  MVP_SETTINGS_ROUTES,
  WORKSPACE_OVERLAY_ROUTE_NAMES,
  type HeaderPreset,
  type MvpAnyRootRouteName,
  type MvpRouteDescriptor,
} from "./navigation/mvpRouteConfig";
import { goBackOrHome } from "./navigation/goBackOrHome";
import { MainTabs } from "./navigation/tabs/MainTabs";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "./native/native-glass";
import { nativeHeaderScrollEdgeEffects } from "./native/StackHeader";
import { useThreadOutboxDrain } from "./state/use-thread-outbox-drain";
import { useNewTaskOutboxDrain } from "./state/use-new-task-outbox-drain";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

// Matches --color-sheet in global.css (light/dark). DynamicColorIOS lets the header
// background stay STATIC config while still adapting to appearance changes.
const SHEET_BACKGROUND_COLOR =
  Platform.OS === "ios"
    ? DynamicColorIOS({ light: "rgba(242, 242, 247, 0.98)", dark: "rgba(13, 13, 13, 0.98)" })
    : undefined;

type AppScreenOptions = NativeStackNavigationOptions & {
  readonly unstable_navigationItemStyle?: "editor";
};

// Shared header presets. GLASS = transparent header over the screen's primary
// scroll view on supported iOS; SOLID = opaque sheet-colored header for surfaces
// whose content scrolls internally (review); SHEET_SOLID = solid header inside
// sheets (centered title, no editor style).
const GLASS_HEADER_OPTIONS: AppScreenOptions = {
  headerBackButtonDisplayMode: "minimal",
  headerBackTitle: "",
  headerLargeTitle: false,
  headerShadowVisible: false,
  headerShown: true,
  headerStyle: NATIVE_LIQUID_GLASS_SUPPORTED
    ? { backgroundColor: "transparent" }
    : SHEET_BACKGROUND_COLOR !== undefined
      ? { backgroundColor: SHEET_BACKGROUND_COLOR as unknown as string }
      : undefined,
  headerTitleStyle: { fontSize: 18, fontWeight: "800" },
  headerTransparent: NATIVE_LIQUID_GLASS_SUPPORTED,
  scrollEdgeEffects: NATIVE_LIQUID_GLASS_SUPPORTED ? HEADER_SCROLL_EDGE_EFFECTS : undefined,
  unstable_navigationItemStyle: NATIVE_LIQUID_GLASS_SUPPORTED ? "editor" : undefined,
};

const SOLID_HEADER_OPTIONS: AppScreenOptions = {
  headerBackButtonDisplayMode: "minimal",
  headerBackTitle: "",
  headerLargeTitle: false,
  headerShadowVisible: false,
  headerShown: true,
  headerStyle:
    SHEET_BACKGROUND_COLOR !== undefined
      ? { backgroundColor: SHEET_BACKGROUND_COLOR as unknown as string }
      : undefined,
  headerTitleStyle: { fontSize: 18, fontWeight: "800" },
  headerTransparent: false,
  unstable_navigationItemStyle: Platform.OS === "ios" ? "editor" : undefined,
};

const SHEET_SOLID_HEADER_OPTIONS: AppScreenOptions = {
  ...SOLID_HEADER_OPTIONS,
  unstable_navigationItemStyle: undefined,
};

// Routes presented as sheets/overlays ON TOP of the workspace. They must not
// influence the adaptive workspace pathname: opening Settings/Connections over
// Home should not change the active thread. Derived from the pure route config.
export const WORKSPACE_OVERLAY_ROUTES = new Set<string>(WORKSPACE_OVERLAY_ROUTE_NAMES);

function headerPresetOptions(preset: HeaderPreset): AppScreenOptions {
  switch (preset) {
    case "glass":
      return GLASS_HEADER_OPTIONS;
    case "solid":
      return SOLID_HEADER_OPTIONS;
    case "sheet-solid":
      return SHEET_SOLID_HEADER_OPTIONS;
    case "none":
      return {};
  }
}

// Map a pure route descriptor to the active-platform native-stack options
// (presentation/detents/grabber/headerShown). `card` is the native default, so
// it is left unset.
function platformPresentationOptions(descriptor: MvpRouteDescriptor): NativeStackNavigationOptions {
  const platform = Platform.OS === "android" ? descriptor.android : descriptor.ios;
  const options: NativeStackNavigationOptions = {};
  if (platform.presentation !== "card") options.presentation = platform.presentation;
  if (platform.sheetAllowedDetents) options.sheetAllowedDetents = [...platform.sheetAllowedDetents];
  if (platform.sheetGrabberVisible !== undefined) {
    options.sheetGrabberVisible = platform.sheetGrabberVisible;
  }
  if (platform.headerShown !== undefined) options.headerShown = platform.headerShown;
  return options;
}

/** Whether the window is wide enough for the workspace inspector (`ThreadWorkspaceLayout`). */
function workspaceInspectorSupported(): boolean {
  const { width, height } = Dimensions.get("window");
  return deriveThreadWorkspaceInspectorPaneLayout({
    layout: deriveLayout({ width, height }),
    viewportWidth: width,
  }).supported;
}

function routeOptions(name: MvpAnyRootRouteName, extras: AppScreenOptions = {}): AppScreenOptions {
  const descriptor: MvpRouteDescriptor = MVP_ALL_ROOT_ROUTES[name];
  return {
    ...headerPresetOptions(descriptor.headerPreset),
    ...platformPresentationOptions(descriptor),
    ...extras,
  };
}

/**
 * Pathname of the topmost NON-overlay route — the screen the workspace is
 * actually "on", regardless of any sheets floating above it.
 */
export function workspacePathFromState(state: NavigationState): string {
  const routes = state.routes.filter((route) => !WORKSPACE_OVERLAY_ROUTES.has(route.name));
  const effectiveState =
    routes.length > 0 && routes.length !== state.routes.length
      ? ({ ...state, routes, index: routes.length - 1 } as NavigationState)
      : state;
  const path = getPathFromState(effectiveState, navigationPathConfig);
  return path.startsWith("/") ? path : `/${path}`;
}

function RootStackLayout(props: {
  readonly children: React.ReactNode;
  readonly state: NavigationState;
}) {
  // Drain the offline outbox on reconnect (real drain lands with the send task).
  useThreadOutboxDrain();
  // New tasks written while their machine was away start once it is live.
  useNewTaskOutboxDrain();
  // Full pathname (sheets included) and the screen beneath any sheets, for
  // keyboard-command scoping.
  const path = getPathFromState(props.state, navigationPathConfig);
  const pathname = path.startsWith("/") ? path : `/${path}`;
  const workspacePathname = workspacePathFromState(props.state);

  return (
    <HardwareKeyboardCommandProvider pathname={pathname} workspacePathname={workspacePathname}>
      <ThreadWorkspaceLayout>{props.children}</ThreadWorkspaceLayout>
    </HardwareKeyboardCommandProvider>
  );
}

function NotFoundScreen() {
  const navigation = useNavigation();
  const screenBgStyle = StyleSheet.flatten(useResolveClassNames("bg-screen"));
  const primaryBgStyle = StyleSheet.flatten(useResolveClassNames("bg-primary"));
  const returnHomeButtonStyle = StyleSheet.flatten([
    { borderRadius: 999, paddingHorizontal: 20, paddingVertical: 14 },
    primaryBgStyle,
  ]);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        flexGrow: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        paddingHorizontal: 24,
        paddingVertical: 32,
      }}
      style={[{ flex: 1 }, screenBgStyle]}
    >
      <Text className="text-3xl font-ryco-bold text-foreground" selectable>
        Route not found
      </Text>
      <Pressable
        style={returnHomeButtonStyle}
        onPress={() => navigation.dispatch(StackActions.replace("Home"))}
      >
        <Text className="text-base font-ryco-bold text-primary-foreground">Return home</Text>
      </Pressable>
    </ScrollView>
  );
}

// The MVP static route tree, built from the pure route config so linking and
// presentation/detents cannot drift from what the route-config test asserts.
// Per-route cosmetic extras (titles, transparent content) stay inline.
export const ROOT_STACK_SCREENS = {
  Access: createNativeStackScreen({
    screen: NativeIdentityScreen,
    linking: MVP_ROOT_ROUTES.Access.linking,
    options: routeOptions("Access", { gestureEnabled: true }),
  }),
  Home: createNativeStackScreen({
    screen: MainTabs,
    linking: MVP_ROOT_ROUTES.Home.linking,
    // The tab in front sets the header's title and buttons (`useTabStackHeader`).
    options: routeOptions("Home", {
      contentStyle: { backgroundColor: "transparent" },
      headerBackVisible: false,
      title: "",
    }),
  }),
  AddProject: createNativeStackScreen({
    screen: AddProjectRouteScreen,
    linking: MVP_ROOT_ROUTES.AddProject.linking,
    options: routeOptions("AddProject", { title: "Add Project", gestureEnabled: true }),
  }),
  Project: createNativeStackScreen({
    screen: ProjectRouteScreen,
    linking: MVP_ROOT_ROUTES.Project.linking,
    options: routeOptions("Project", { title: "Project" }),
  }),
  ProjectSourceControl: createNativeStackScreen({
    screen: SourceControlRouteScreen,
    linking: MVP_ROOT_ROUTES.ProjectSourceControl.linking,
    options: routeOptions("ProjectSourceControl", { title: "Source Control" }),
  }),
  ProjectBranches: createNativeStackScreen({
    screen: SourceControlBranchesRouteScreen,
    linking: MVP_ROOT_ROUTES.ProjectBranches.linking,
    options: routeOptions("ProjectBranches", { title: "Branches", gestureEnabled: true }),
  }),
  ProjectCommit: createNativeStackScreen({
    screen: SourceControlCommitRouteScreen,
    linking: MVP_ROOT_ROUTES.ProjectCommit.linking,
    options: routeOptions("ProjectCommit", { title: "Commit", gestureEnabled: true }),
  }),
  ProjectChanges: createNativeStackScreen({
    screen: SourceControlChangesRouteScreen,
    linking: MVP_ROOT_ROUTES.ProjectChanges.linking,
    options: routeOptions("ProjectChanges", { title: "Changes" }),
  }),
  ProjectCompare: createNativeStackScreen({
    screen: SourceControlCompareRouteScreen,
    linking: MVP_ROOT_ROUTES.ProjectCompare.linking,
    options: routeOptions("ProjectCompare", { title: "Compare" }),
  }),
  ProjectPublish: createNativeStackScreen({
    screen: SourceControlPublishRouteScreen,
    linking: MVP_ROOT_ROUTES.ProjectPublish.linking,
    options: routeOptions("ProjectPublish", { title: "Publish", gestureEnabled: true }),
  }),
  ProjectNotes: createNativeStackScreen({
    screen: ProjectNotesRouteScreen,
    linking: MVP_ROOT_ROUTES.ProjectNotes.linking,
    options: routeOptions("ProjectNotes", { title: "Notes" }),
  }),
  ProjectExplorer: createNativeStackScreen({
    screen: ProjectExplorerRouteScreen,
    linking: MVP_ROOT_ROUTES.ProjectExplorer.linking,
    options: routeOptions("ProjectExplorer", { title: "Explorer" }),
  }),
  ProjectNewIssue: createNativeStackScreen({
    screen: ProjectNewIssueRouteScreen,
    linking: MVP_ROOT_ROUTES.ProjectNewIssue.linking,
    options: routeOptions("ProjectNewIssue", { title: "New issue", gestureEnabled: true }),
  }),
  ProjectIssue: createNativeStackScreen({
    screen: ProjectIssueRouteScreen,
    linking: MVP_ROOT_ROUTES.ProjectIssue.linking,
    options: routeOptions("ProjectIssue", { title: "Issue" }),
  }),
  ProjectWorkflowRun: createNativeStackScreen({
    screen: ProjectWorkflowRunRouteScreen,
    linking: MVP_ROOT_ROUTES.ProjectWorkflowRun.linking,
    options: routeOptions("ProjectWorkflowRun", { title: "Run" }),
  }),
  ProjectWorkItem: createNativeStackScreen({
    screen: ProjectWorkItemRouteScreen,
    linking: MVP_ROOT_ROUTES.ProjectWorkItem.linking,
    options: routeOptions("ProjectWorkItem", { title: "Work item" }),
  }),
  ProjectPullRequests: createNativeStackScreen({
    screen: PullRequestsRouteScreen,
    linking: MVP_ROOT_ROUTES.ProjectPullRequests.linking,
    options: routeOptions("ProjectPullRequests", { title: "Pull requests" }),
  }),
  ProjectPullRequest: createNativeStackScreen({
    screen: PullRequestRouteScreen,
    linking: MVP_ROOT_ROUTES.ProjectPullRequest.linking,
    // The title is `#number`, which the screen sets once the param is parsed.
    options: routeOptions("ProjectPullRequest"),
  }),
  ProjectPullRequestFile: createNativeStackScreen({
    screen: PullRequestFileRouteScreen,
    linking: MVP_ROOT_ROUTES.ProjectPullRequestFile.linking,
    // The title is the file's basename, which only the screen knows.
    options: routeOptions("ProjectPullRequestFile"),
  }),
  NewTask: createNativeStackScreen({
    screen: NewTaskRouteScreen,
    linking: MVP_ROOT_ROUTES.NewTask.linking,
    options: routeOptions("NewTask", { title: "New Task" }),
  }),
  TaskDetail: createNativeStackScreen({
    screen: TaskDetailRouteScreen,
    linking: MVP_ROOT_ROUTES.TaskDetail.linking,
    options: routeOptions("TaskDetail", { title: "Task" }),
  }),
  Scheduled: createNativeStackScreen({
    screen: ScheduledRouteScreen,
    linking: MVP_ROOT_ROUTES.Scheduled.linking,
    options: routeOptions("Scheduled", { title: "Scheduled" }),
  }),
  ScheduleDetail: createNativeStackScreen({
    screen: ScheduleDetailRouteScreen,
    linking: MVP_ROOT_ROUTES.ScheduleDetail.linking,
    // The title is the schedule's, which the screen sets once it is read.
    options: routeOptions("ScheduleDetail", { title: "Schedule" }),
  }),
  ScheduleEditor: createNativeStackScreen({
    screen: ScheduleEditorRouteScreen,
    linking: MVP_ROOT_ROUTES.ScheduleEditor.linking,
    options: routeOptions("ScheduleEditor", { title: "Schedule" }),
  }),
  Thread: createNativeStackScreen({
    screen: ThreadRouteScreen,
    linking: MVP_ROOT_ROUTES.Thread.linking,
    options: routeOptions("Thread"),
  }),
  ThreadReview: createNativeStackScreen({
    screen: ReviewSheet,
    linking: MVP_ROOT_ROUTES.ThreadReview.linking,
    options: routeOptions("ThreadReview"),
  }),
  ThreadReviewComment: createNativeStackScreen({
    screen: ReviewCommentComposerSheet,
    linking: MVP_ROOT_ROUTES.ThreadReviewComment.linking,
    options: routeOptions("ThreadReviewComment"),
  }),
  ThreadFiles: createNativeStackScreen({
    screen: ThreadFilesRouteScreen,
    linking: MVP_ROOT_ROUTES.ThreadFiles.linking,
    options: routeOptions("ThreadFiles", { title: "Files" }),
  }),
  ThreadFile: createNativeStackScreen({
    screen: ThreadFileRouteScreen,
    linking: MVP_ROOT_ROUTES.ThreadFile.linking,
    // The title is the file's basename, which only the screen knows; it sets it
    // through `navigation.setOptions` once the path param has been normalized.
    options: routeOptions("ThreadFile"),
  }),
  ThreadFileEdit: createNativeStackScreen({
    screen: ThreadFileEditRouteScreen,
    linking: MVP_ROOT_ROUTES.ThreadFileEdit.linking,
    // The title is the file's basename, which the screen sets.
    options: routeOptions("ThreadFileEdit"),
  }),
  ThreadFileSearch: createNativeStackScreen({
    screen: ThreadFileSearchRouteScreen,
    linking: MVP_ROOT_ROUTES.ThreadFileSearch.linking,
    options: routeOptions("ThreadFileSearch", { title: "Find in files" }),
  }),
  ThreadScripts: createNativeStackScreen({
    screen: ThreadScriptsRouteScreen,
    linking: MVP_ROOT_ROUTES.ThreadScripts.linking,
    options: routeOptions("ThreadScripts", { title: "Run script", gestureEnabled: true }),
  }),
  ThreadDevices: createNativeStackScreen({
    screen: ThreadDevicesRouteScreen,
    linking: MVP_ROOT_ROUTES.ThreadDevices.linking,
    options: routeOptions("ThreadDevices", { title: "Devices", gestureEnabled: true }),
  }),
  ThreadServers: createNativeStackScreen({
    screen: ThreadServersRouteScreen,
    linking: MVP_ROOT_ROUTES.ThreadServers.linking,
    options: routeOptions("ThreadServers", { title: "Servers", gestureEnabled: true }),
  }),
  ThreadBrowser: createNativeStackScreen({
    screen: ThreadBrowserRouteScreen,
    linking: MVP_ROOT_ROUTES.ThreadBrowser.linking,
    // The title is the tab's, which the screen sets.
    options: routeOptions("ThreadBrowser", { title: "Preview" }),
  }),
  ThreadDevice: createNativeStackScreen({
    screen: ThreadDeviceRouteScreen,
    linking: MVP_ROOT_ROUTES.ThreadDevice.linking,
    // A regular-width window shows the device in the workspace inspector beside
    // the thread, so the route is a card there, like Terminal; a full-screen
    // modal would cover the inspector column.
    options: () =>
      workspaceInspectorSupported()
        ? routeOptions("ThreadTerminal", { title: "Device" })
        : routeOptions("ThreadDevice", { title: "Device" }),
  }),
  ThreadTerminal: createNativeStackScreen({
    screen: ThreadTerminalRouteScreen,
    linking: MVP_ROOT_ROUTES.ThreadTerminal.linking,
    options: routeOptions("ThreadTerminal", { title: "Terminal" }),
  }),
  Connections: createNativeStackScreen({
    screen: ConnectionsRouteScreen,
    linking: MVP_ROOT_ROUTES.Connections.linking,
    options: routeOptions("Connections", { title: "Machines" }),
  }),
  ConnectionsNew: createNativeStackScreen({
    screen: ConnectionsNewRouteScreen,
    linking: MVP_ROOT_ROUTES.ConnectionsNew.linking,
    options: routeOptions("ConnectionsNew", { title: "Add a machine" }),
  }),
  Search: createNativeStackScreen({
    screen: GlobalSearchRouteScreen,
    linking: MVP_ROOT_ROUTES.Search.linking,
    // The field takes the place of the header; the list fades in under it.
    options: routeOptions("Search", { animation: "fade", headerShown: false }),
  }),
  SettingsHub: createNativeStackScreen({
    screen: SettingsHubRouteScreen,
    linking: MVP_SETTINGS_ROUTES.SettingsHub.linking,
    options: routeOptions("SettingsHub", { title: "Hub" }),
  }),
  SettingsWorkspace: createNativeStackScreen({
    screen: SettingsWorkspaceRouteScreen,
    linking: MVP_SETTINGS_ROUTES.SettingsWorkspace.linking,
    options: routeOptions("SettingsWorkspace", { title: "Workspace defaults" }),
  }),
  SettingsProviderAccounts: createNativeStackScreen({
    screen: SettingsProviderAccountsRouteScreen,
    linking: MVP_SETTINGS_ROUTES.SettingsProviderAccounts.linking,
    options: routeOptions("SettingsProviderAccounts", { title: "Provider accounts" }),
  }),
  SettingsInbox: createNativeStackScreen({
    screen: SettingsInboxRouteScreen,
    linking: MVP_SETTINGS_ROUTES.SettingsInbox.linking,
    options: routeOptions("SettingsInbox", { title: SETTINGS_SECTION_TITLES.inbox }),
  }),
  SettingsArchived: createNativeStackScreen({
    screen: ArchivedThreadsRouteScreen,
    linking: MVP_SETTINGS_ROUTES.SettingsArchived.linking,
    options: routeOptions("SettingsArchived", { title: "Archived tasks" }),
  }),
  SettingsNotifications: createNativeStackScreen({
    screen: SettingsNotificationsRouteScreen,
    linking: MVP_SETTINGS_ROUTES.SettingsNotifications.linking,
    options: routeOptions("SettingsNotifications", {
      title: SETTINGS_SECTION_TITLES.notifications,
    }),
  }),
  SettingsAccount: createNativeStackScreen({
    screen: HostedAccountRouteScreen,
    linking: MVP_SETTINGS_ROUTES.SettingsAccount.linking,
    options: routeOptions("SettingsAccount", { title: "Hub Account" }),
  }),
  // docs/relay-e2ee-protocol.md §13.1.1's security UI and §13.2's ceremony.
  // Both are pushes on both platforms (see `mvpRouteConfig.ts`).
  SettingsMachines: createNativeStackScreen({
    screen: SettingsMachinesRouteScreen,
    linking: MVP_SETTINGS_ROUTES.SettingsMachines.linking,
    options: routeOptions("SettingsMachines", { title: "Machine settings" }),
  }),
  SettingsMachine: createNativeStackScreen({
    screen: SettingsMachineRouteScreen,
    linking: MVP_SETTINGS_ROUTES.SettingsMachine.linking,
    options: routeOptions("SettingsMachine", { title: "Machine" }),
  }),
  SettingsMachineProviders: createNativeStackScreen({
    screen: SettingsMachineProvidersRouteScreen,
    linking: MVP_SETTINGS_ROUTES.SettingsMachineProviders.linking,
    options: routeOptions("SettingsMachineProviders", { title: "Providers" }),
  }),
  SettingsMachineProvider: createNativeStackScreen({
    screen: SettingsMachineProviderRouteScreen,
    linking: MVP_SETTINGS_ROUTES.SettingsMachineProvider.linking,
    options: routeOptions("SettingsMachineProvider", { title: "Provider" }),
  }),
  SettingsMachineAgents: createNativeStackScreen({
    screen: SettingsMachineAgentsRouteScreen,
    linking: MVP_SETTINGS_ROUTES.SettingsMachineAgents.linking,
    options: routeOptions("SettingsMachineAgents", { title: "Agents" }),
  }),
  SettingsMachineWork: createNativeStackScreen({
    screen: SettingsMachineWorkRouteScreen,
    linking: MVP_SETTINGS_ROUTES.SettingsMachineWork.linking,
    options: routeOptions("SettingsMachineWork", { title: "Work" }),
  }),
  SettingsMachineSystem: createNativeStackScreen({
    screen: SettingsMachineSystemRouteScreen,
    linking: MVP_SETTINGS_ROUTES.SettingsMachineSystem.linking,
    options: routeOptions("SettingsMachineSystem", { title: "Machine" }),
  }),
  SettingsMachineUsagePrices: createNativeStackScreen({
    screen: SettingsMachineUsagePricesRouteScreen,
    linking: MVP_SETTINGS_ROUTES.SettingsMachineUsagePrices.linking,
    options: routeOptions("SettingsMachineUsagePrices", { title: "Usage prices" }),
  }),
  SettingsMachineImport: createNativeStackScreen({
    screen: SettingsMachineImportRouteScreen,
    linking: MVP_SETTINGS_ROUTES.SettingsMachineImport.linking,
    options: routeOptions("SettingsMachineImport", { title: "Import conversations" }),
  }),
  SettingsNodeSecurity: createNativeStackScreen({
    screen: E2eeNodeSecurityRouteScreen,
    linking: MVP_SETTINGS_ROUTES.SettingsNodeSecurity.linking,
    options: routeOptions("SettingsNodeSecurity", { title: "Node security" }),
  }),
  SettingsNodeVerification: createNativeStackScreen({
    screen: E2eeNodeVerificationRouteScreen,
    linking: MVP_SETTINGS_ROUTES.SettingsNodeVerification.linking,
    options: routeOptions("SettingsNodeVerification", { title: "Verify node" }),
  }),
  SettingsAppearance: createNativeStackScreen({
    screen: SettingsAppearanceRouteScreen,
    linking: MVP_SETTINGS_ROUTES.SettingsAppearance.linking,
    options: routeOptions("SettingsAppearance", { title: "Appearance" }),
  }),
  SettingsClientStorage: createNativeStackScreen({
    screen: SettingsClientStorageRouteScreen,
    linking: MVP_SETTINGS_ROUTES.SettingsClientStorage.linking,
    options: routeOptions("SettingsClientStorage", { title: "Client Storage" }),
  }),
  SettingsDiagnostics: createNativeStackScreen({
    screen: SettingsDiagnosticsRouteScreen,
    linking: MVP_SETTINGS_ROUTES.SettingsDiagnostics.linking,
    options: routeOptions("SettingsDiagnostics", { title: "Diagnostics" }),
  }),
  SettingsAbout: createNativeStackScreen({
    screen: SettingsAboutRouteScreen,
    linking: MVP_SETTINGS_ROUTES.SettingsAbout.linking,
    options: routeOptions("SettingsAbout", { title: "About" }),
  }),
  NotFound: createNativeStackScreen({
    screen: NotFoundScreen,
    linking: MVP_ROOT_ROUTES.NotFound.linking,
  }),
} as const;

export const RootStack = createNativeStackNavigator({
  initialRouteName: "Home",
  layout: RootStackLayout,
  screenOptions: ({ navigation, route }) => ({
    headerShown: false,
    headerLeft: (() => {
      const action = (
        MVP_ALL_ROOT_ROUTES[route.name as MvpAnyRootRouteName] as MvpRouteDescriptor | undefined
      )?.headerAction;
      if (action === undefined || action === "none") return undefined;
      return () => (
        <NavigationHeaderButton action={action} onPress={() => goBackOrHome(navigation)} />
      );
    })(),
  }),
  screens: ROOT_STACK_SCREENS,
});
type RootStackType = typeof RootStack;

const navigationPathConfig = {
  screens: createPathConfigForStaticNavigation(RootStack) ?? {},
};

declare module "@react-navigation/native" {
  interface RootNavigator extends RootStackType {}
}
