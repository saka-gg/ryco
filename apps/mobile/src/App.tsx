import { BlurTargetView } from "expo-blur";
import * as Linking from "expo-linking";
import {
  installAppShortcuts,
  shortcutAwareLinking,
} from "./features/shortcuts/appShortcutsRuntime";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useState, useSyncExternalStore } from "react";
import { StatusBar } from "react-native";
import { DarkTheme, DefaultTheme, getStateFromPath } from "@react-navigation/native";

import { applyResolvedAppColorScheme, resolveAppColorScheme } from "./lib/appScheme";

import { SidebarUndoNoticeHost } from "./components/SidebarUndoNoticeHost";
import { ProjectCopyRuntimeHost } from "./features/projectCopy/ProjectCopyRuntimeHost";
import { ConfirmDialogHost } from "./components/ConfirmDialogHost";
import { OverlayPortalHost } from "./components/OverlayPortal";
import {
  AppearancePreferencesProvider,
  useAppearancePreferences,
} from "./features/settings/appearance/AppearancePreferencesProvider";
import { appBlurTargetRef } from "./lib/appBlurTarget";
import { useThemeColor } from "./lib/useThemeColor";
import { ConnectionRegistryProvider } from "./providers/ConnectionRegistryProvider";
import { AppProviders } from "./providers/AppProviders";
import { FatalRenderErrorBoundary } from "./diagnostics/FatalRenderErrorBoundary";
import { useHostedAppLifecycle } from "./hostedHub/useHostedAppLifecycle";
import { noteMobileClientInteraction } from "./runtime/clientInteraction";
import { rewriteIncomingSharePath } from "./features/sharing/incomingShareModel";
import { rewriteLegacyTabPath } from "./navigation/tabs/mainTabsModel";
import { AppAccessGate } from "./features/access/AppAccessGate";
import { TaskCaptureHost } from "./features/tasks/TaskCaptureHost";
import {
  isAppAccessDecided,
  shouldHideLaunchSplash,
  SPLASH_ACCESS_DECISION_WAIT_MS,
  subscribeAppAccessDecided,
} from "./features/access/launchDecision";

import "../global.css";

void SplashScreen.preventAutoHideAsync().catch(() => {
  // The native module can be unavailable in non-native test environments.
});

// Resolve + apply the app color scheme once, before first render, so Uniwind's
// active `@variant` and RN's Appearance (useColorScheme → nav theme + status bar)
// are dark from the very first paint (§4).
applyResolvedAppColorScheme();

// Per-variant plain schemes shipped by B1's app.config.ts (§7 divergence: these
// supersede the spec's reverse-DNS wording). Deep links carry only
// environmentId/threadId params — never credentials.
const appLinking = {
  prefixes: [Linking.createURL("/"), "ryco://", "ryco-dev://", "ryco-preview://"],
  // The Expo dev client launches via <scheme>://expo-development-client/?url=...,
  // which addresses the launcher, not app navigation. Without this filter it
  // falls through to the NotFound wildcard on every dev launch.
  filter: (url: string) => !url.includes("expo-development-client"),
  // Home-screen quick actions arrive as app paths through the same config.
  getInitialURL: shortcutAwareLinking.getInitialURL,
  subscribe: shortcutAwareLinking.subscribe,
  // The share extension opens <scheme>://expo-sharing: New Task takes the share. Links an
  // earlier build wrote for a screen that is a tab now open that tab.
  getStateFromPath: (path: string, options?: Parameters<typeof getStateFromPath>[1]) =>
    getStateFromPath(rewriteLegacyTabPath(rewriteIncomingSharePath(path)), options),
};

/**
 * Hands the native splash straight to the gate's first real surface. Once
 * preferences are ready the splash waits (bounded) for the access gate to
 * decide, so a launch that resolves quickly goes splash → workspace instead of
 * splash → launch logo → workspace.
 */
function SplashScreenCoordinator() {
  const { isReady } = useAppearancePreferences();
  const accessDecided = useSyncExternalStore(subscribeAppAccessDecided, isAppAccessDecided);
  const [decisionWaitElapsed, setDecisionWaitElapsed] = useState(false);

  useEffect(() => {
    if (!isReady || accessDecided) return;
    const timer = setTimeout(() => setDecisionWaitElapsed(true), SPLASH_ACCESS_DECISION_WAIT_MS);
    return () => clearTimeout(timer);
  }, [accessDecided, isReady]);

  const hide = shouldHideLaunchSplash({
    preferencesReady: isReady,
    accessDecided,
    decisionWaitElapsed,
  });
  useEffect(() => {
    if (hide) void SplashScreen.hide();
  }, [hide]);

  return null;
}

/**
 * Drives the hosted browser lifecycle from app foreground/background and
 * connectivity. Mounted once, above every hosted surface: iOS tears down
 * sockets on background, and without this the runtime never learns, so the
 * transport keeps reconnecting and issuing fresh relay tickets while
 * backgrounded instead of suspending. Inert when hosted mode is unconfigured.
 */
function HostedAppLifecycle() {
  useHostedAppLifecycle();
  return null;
}

// The boundary goes around everything, App's own hooks included: a crash while
// rendering never reaches the global handler, so this is where it is recorded.
export default function App() {
  return (
    <FatalRenderErrorBoundary>
      <AppRoot />
    </FatalRenderErrorBoundary>
  );
}

// B2 app root: B1's provider stack (gesture/atom-registry/safe-area/keyboard) +
// the connection-registry context + appearance preferences, then the full
// navigation shell. Cloud auth and the showcase rig are stripped.
function AppRoot() {
  // Resolved via the single scheme seam, not the raw system scheme — dark today,
  // preference-overridable later (§4). Re-assert on mount so Fast Refresh keeps it.
  applyResolvedAppColorScheme();
  const colorScheme = resolveAppColorScheme();
  const statusBarBg = useThemeColor("--color-status-bar");
  // Puts New task and the recent threads on the app icon's quick actions.
  useEffect(() => installAppShortcuts(), []);

  return (
    <AppProviders>
      <ConnectionRegistryProvider>
        <AppearancePreferencesProvider>
          <SplashScreenCoordinator />
          <HostedAppLifecycle />
          <StatusBar
            barStyle={colorScheme === "dark" ? "light-content" : "dark-content"}
            backgroundColor={statusBarBg}
            translucent
          />
          {/* The navigation theme drives the NATIVE header appearance (dark ->
              overrideUserInterfaceStyle). Blur target hosts Android dropdown
              backdrops (see appBlurTarget.ts). */}
          {/* Touches bubble here from every screen (observed, never handled): machines that
              update themselves unattended wait while someone uses the app. */}
          <BlurTargetView
            ref={appBlurTargetRef}
            style={{ flex: 1 }}
            onTouchStart={noteMobileClientInteraction}
          >
            <AppAccessGate
              linking={appLinking}
              theme={colorScheme === "dark" ? DarkTheme : DefaultTheme}
            />
            <ConfirmDialogHost />
            <SidebarUndoNoticeHost />
            <TaskCaptureHost />
            {/* Copies to other machines run on after their screen closes. */}
            <ProjectCopyRuntimeHost />
          </BlurTargetView>
          {/* Anchored-menu overlays render here — in-window, so the keyboard
              stays up while a dropdown is open. */}
          <OverlayPortalHost />
        </AppearancePreferencesProvider>
      </ConnectionRegistryProvider>
    </AppProviders>
  );
}
