import { BlurTargetView } from "expo-blur";
import * as Linking from "expo-linking";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { StatusBar } from "react-native";
import { DarkTheme, DefaultTheme } from "@react-navigation/native";

import { applyResolvedAppColorScheme, resolveAppColorScheme } from "./lib/appScheme";

import { SidebarUndoNoticeHost } from "./components/SidebarUndoNoticeHost";
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
import { useHostedAppLifecycle } from "./hostedHub/useHostedAppLifecycle";
import { AppAccessGate } from "./features/access/AppAccessGate";

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
};

function SplashScreenCoordinator() {
  const { isReady } = useAppearancePreferences();

  useEffect(() => {
    if (isReady) void SplashScreen.hide();
  }, [isReady]);

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

// B2 app root: B1's provider stack (gesture/atom-registry/safe-area/keyboard) +
// the connection-registry context + appearance preferences, then the full
// navigation shell. Cloud auth, incoming-share, and the showcase rig are stripped.
export default function App() {
  // Resolved via the single scheme seam, not the raw system scheme — dark today,
  // preference-overridable later (§4). Re-assert on mount so Fast Refresh keeps it.
  applyResolvedAppColorScheme();
  const colorScheme = resolveAppColorScheme();
  const statusBarBg = useThemeColor("--color-status-bar");

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
          <BlurTargetView ref={appBlurTargetRef} style={{ flex: 1 }}>
            <AppAccessGate
              linking={appLinking}
              theme={colorScheme === "dark" ? DarkTheme : DefaultTheme}
            />
            <ConfirmDialogHost />
            <SidebarUndoNoticeHost />
          </BlurTargetView>
          {/* Anchored-menu overlays render here — in-window, so the keyboard
              stays up while a dropdown is open. */}
          <OverlayPortalHost />
        </AppearancePreferencesProvider>
      </ConnectionRegistryProvider>
    </AppProviders>
  );
}
