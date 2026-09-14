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
import { DynamicColorIOS, Platform, Pressable, ScrollView, StyleSheet } from "react-native";
import { useResolveClassNames } from "uniwind";

import { AppText as Text } from "./components/AppText";
import { NavigationHeaderButton } from "./components/NavigationHeaderButton";
import { HardwareKeyboardCommandProvider } from "./features/keyboard/HardwareKeyboardCommandProvider";
import { ConnectionsRouteScreen } from "./features/connection/ConnectionsRouteScreen";
import { ConnectionsNewRouteScreen } from "./features/connection/ConnectionsNewRouteScreen";
import { E2eeNodeSecurityRouteScreen } from "./features/e2ee/E2eeNodeSecurityRouteScreen";
import { E2eeNodeVerificationRouteScreen } from "./features/e2ee/E2eeNodeVerificationRouteScreen";
import { FileWorkspaceLayout } from "./features/files/FileWorkspaceLayout";
import { ThreadFileRouteScreen } from "./features/files/ThreadFileRouteScreen";
import { ThreadFilesRouteScreen } from "./features/files/ThreadFilesRouteScreen";
import { HomeRouteScreen } from "./features/home/HomeRouteScreen";
import { HostedAccountRouteScreen } from "./features/hostedHub/HostedAccountRouteScreen";
import { NativeIdentityScreen } from "./features/identity/NativeIdentityScreen";
import { NewTaskRouteScreen } from "./features/newTask/NewTaskRouteScreen";
import { AddProjectRouteScreen } from "./features/projects/AddProjectRouteScreen";
import { ProjectRouteScreen } from "./features/projects/ProjectRouteScreen";
import { ReviewCommentComposerSheet } from "./features/review/ReviewCommentComposerSheet";
import { ReviewSheet } from "./features/review/ReviewSheet";
import { SourceControlRouteScreen } from "./features/sourceControl/SourceControlRouteScreen";
import { SettingsAppearanceRouteScreen } from "./features/settings/SettingsAppearanceRouteScreen";
import { SettingsAboutRouteScreen } from "./features/settings/SettingsAboutRouteScreen";
import { SettingsClientStorageRouteScreen } from "./features/settings/SettingsClientStorageRouteScreen";
import { SettingsHubRouteScreen } from "./features/settings/SettingsHubRouteScreen";
import { SettingsStatisticsRouteScreen } from "./features/settings/SettingsStatisticsRouteScreen";
import { SettingsInboxRouteScreen } from "./features/settings/SettingsInboxRouteScreen";
import { SettingsRouteScreen } from "./features/settings/SettingsRouteScreen";
import { SettingsWorkspaceRouteScreen } from "./features/settings/SettingsWorkspaceRouteScreen";
import { ThreadRouteScreen } from "./features/threads/ThreadRouteScreen";
import {
  MVP_ROOT_ROUTES,
  MVP_SETTINGS_SHEET_ROUTES,
  WORKSPACE_OVERLAY_ROUTE_NAMES,
  type HeaderPreset,
  type MvpRouteDescriptor,
  type MvpSettingsRouteDescriptor,
} from "./navigation/mvpRouteConfig";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "./native/native-glass";
import { nativeHeaderScrollEdgeEffects } from "./native/StackHeader";
import { useThreadOutboxDrain } from "./state/use-thread-outbox-drain";

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

/**
 * Map a nested settings descriptor to the active platform's native-stack
 * options, exactly as `platformPresentationOptions` does for the root routes.
 *
 * It exists because the descriptors did not reach the navigator: every screen
 * below hand-wrote its `options`, so `MVP_SETTINGS_SHEET_ROUTES`'s per-platform
 * presentation was a constant two tests asserted about and nothing consumed.
 * `docs/relay-e2ee-protocol.md` §13.1.1 forbids an indication that "dismisses
 * into a verified-looking state", and a swipe-away sheet is the nearest thing
 * this navigator has to one — a property worth more than the fact that nobody
 * has set a presentation yet.
 */
function settingsRouteOptions(
  name: keyof typeof MVP_SETTINGS_SHEET_ROUTES,
  title: string,
): AppScreenOptions {
  // Widened to the declared descriptor: the table is `as const`, so the literal
  // type of a route that is a plain push carries no sheet fields at all and the
  // shape below would stop compiling the moment one of them is set.
  const descriptor: MvpSettingsRouteDescriptor = MVP_SETTINGS_SHEET_ROUTES[name];
  const platform = Platform.OS === "android" ? descriptor.android : descriptor.ios;
  const options: AppScreenOptions = { title };
  if (platform.presentation !== "card") options.presentation = platform.presentation;
  if (platform.sheetAllowedDetents) options.sheetAllowedDetents = [...platform.sheetAllowedDetents];
  if (platform.sheetGrabberVisible !== undefined) {
    options.sheetGrabberVisible = platform.sheetGrabberVisible;
  }
  if (platform.headerShown !== undefined) options.headerShown = platform.headerShown;
  return options;
}

// Expandable Settings sheet stack. Routine node switching and pairing live in the
// Nodes Home mode; Settings owns account, defaults, appearance, storage, and
// About without duplicating the connection browser.
const SettingsSheetStack = createNativeStackNavigator({
  initialRouteName: "Settings",
  screenOptions: ({ navigation, route }) => ({
    ...SHEET_SOLID_HEADER_OPTIONS,
    unstable_navigationItemStyle: undefined,
    headerLeft:
      MVP_SETTINGS_SHEET_ROUTES[route.name as keyof typeof MVP_SETTINGS_SHEET_ROUTES]
        ?.headerAction === "back"
        ? () => (
            <NavigationHeaderButton
              action="back"
              onPress={() => {
                if (navigation.canGoBack()) {
                  navigation.goBack();
                  return;
                }
                navigation.dispatch(StackActions.replace("Settings"));
              }}
            />
          )
        : undefined,
  }),
  screens: {
    Settings: createNativeStackScreen({
      screen: SettingsRouteScreen,
      linking: MVP_SETTINGS_SHEET_ROUTES.Settings.linking,
      options: settingsRouteOptions("Settings", "Settings"),
    }),
    SettingsHub: createNativeStackScreen({
      screen: SettingsHubRouteScreen,
      linking: MVP_SETTINGS_SHEET_ROUTES.SettingsHub.linking,
      options: settingsRouteOptions("SettingsHub", "Hub"),
    }),
    SettingsWorkspace: createNativeStackScreen({
      screen: SettingsWorkspaceRouteScreen,
      linking: MVP_SETTINGS_SHEET_ROUTES.SettingsWorkspace.linking,
      options: settingsRouteOptions("SettingsWorkspace", "Workspace defaults"),
    }),
    SettingsStatistics: createNativeStackScreen({
      screen: SettingsStatisticsRouteScreen,
      linking: MVP_SETTINGS_SHEET_ROUTES.SettingsStatistics.linking,
      options: settingsRouteOptions("SettingsStatistics", "Statistics"),
    }),
    SettingsInbox: createNativeStackScreen({
      screen: SettingsInboxRouteScreen,
      linking: MVP_SETTINGS_SHEET_ROUTES.SettingsInbox.linking,
      options: settingsRouteOptions("SettingsInbox", "Inbox and AI Focus"),
    }),
    SettingsAccount: createNativeStackScreen({
      screen: HostedAccountRouteScreen,
      linking: MVP_SETTINGS_SHEET_ROUTES.SettingsAccount.linking,
      options: settingsRouteOptions("SettingsAccount", "Hub Account"),
    }),
    // docs/relay-e2ee-protocol.md §13.1.1's security UI and §13.2's ceremony.
    // Both are pushes on both platforms (see `mvpRouteConfig.ts`): §13.1.1
    // forbids an indication that dismisses into a verified-looking state, and a
    // swipe-away sheet is the nearest thing this navigator has to one.
    SettingsNodeSecurity: createNativeStackScreen({
      screen: E2eeNodeSecurityRouteScreen,
      linking: MVP_SETTINGS_SHEET_ROUTES.SettingsNodeSecurity.linking,
      options: settingsRouteOptions("SettingsNodeSecurity", "Node security"),
    }),
    SettingsNodeVerification: createNativeStackScreen({
      screen: E2eeNodeVerificationRouteScreen,
      linking: MVP_SETTINGS_SHEET_ROUTES.SettingsNodeVerification.linking,
      options: settingsRouteOptions("SettingsNodeVerification", "Verify node"),
    }),
    SettingsAppearance: createNativeStackScreen({
      screen: SettingsAppearanceRouteScreen,
      linking: MVP_SETTINGS_SHEET_ROUTES.SettingsAppearance.linking,
      options: settingsRouteOptions("SettingsAppearance", "Appearance"),
    }),
    SettingsClientStorage: createNativeStackScreen({
      screen: SettingsClientStorageRouteScreen,
      linking: MVP_SETTINGS_SHEET_ROUTES.SettingsClientStorage.linking,
      options: settingsRouteOptions("SettingsClientStorage", "Client Storage"),
    }),
    SettingsAbout: createNativeStackScreen({
      screen: SettingsAboutRouteScreen,
      linking: MVP_SETTINGS_SHEET_ROUTES.SettingsAbout.linking,
      options: settingsRouteOptions("SettingsAbout", "About"),
    }),
  },
});

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

function routeOptions(
  name: keyof typeof MVP_ROOT_ROUTES,
  extras: AppScreenOptions = {},
): AppScreenOptions {
  const descriptor = MVP_ROOT_ROUTES[name];
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
  // Full pathname (sheets included) for keyboard-command scoping.
  const path = getPathFromState(props.state, navigationPathConfig);
  const pathname = path.startsWith("/") ? path : `/${path}`;

  return (
    <HardwareKeyboardCommandProvider pathname={pathname}>
      <FileWorkspaceLayout>{props.children}</FileWorkspaceLayout>
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
    screen: HomeRouteScreen,
    linking: MVP_ROOT_ROUTES.Home.linking,
    options: routeOptions("Home", {
      contentStyle: { backgroundColor: "transparent" },
      headerBackVisible: false,
      title: "Inbox",
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
  NewTask: createNativeStackScreen({
    screen: NewTaskRouteScreen,
    linking: MVP_ROOT_ROUTES.NewTask.linking,
    options: routeOptions("NewTask", { title: "New Task" }),
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
  SettingsSheet: createNativeStackScreen({
    screen: SettingsSheetStack,
    linking: MVP_ROOT_ROUTES.SettingsSheet.linking,
    options: routeOptions("SettingsSheet", { gestureEnabled: true, headerShown: false }),
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
      const action = MVP_ROOT_ROUTES[route.name as keyof typeof MVP_ROOT_ROUTES]?.headerAction;
      if (action === undefined || action === "none") return undefined;
      return () => (
        <NavigationHeaderButton
          action={action}
          onPress={() => {
            if (navigation.canGoBack()) {
              navigation.goBack();
              return;
            }
            navigation.dispatch(StackActions.replace("Home"));
          }}
        />
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
