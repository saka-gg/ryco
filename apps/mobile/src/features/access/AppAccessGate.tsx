import { createStaticNavigation } from "@react-navigation/native";
import {
  createNativeStackNavigator,
  createNativeStackScreen,
} from "@react-navigation/native-stack";
import { Image } from "expo-image";
import * as Linking from "expo-linking";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";

import { ConnectionsNewRouteScreen, NativeIdentityScreen } from "../../navigation/lazyRouteScreens";
import { useHostedHubStore, ensureMobileHostedSession } from "../../hostedHub/state";
import { useThemeColor } from "../../lib/useThemeColor";
import { useConnectionRegistry } from "../../providers/ConnectionRegistryProvider";
import { RootStack } from "../../Stack";
import { ServerStateBootstrap } from "../../state/serverStateSync";
import { deriveAppAccess, isWorkspaceDeepLink } from "./appAccessModel";
import { watchDirectCredentialAccess } from "./directCredentialAccess";
import { HOSTED_LAUNCH_DECISION_DEADLINE_MS, markAppAccessDecided } from "./launchDecision";
import { ThreadPriorityRefreshBridge } from "../../components/ThreadPriorityRefreshBridge";
import { ThreadAlertsBridge } from "../../notifications/ThreadAlertsBridge";

const logo = require("../../../../../assets/logo_letter_only.svg");

const LockedStack = createNativeStackNavigator({
  initialRouteName: "Access",
  screenOptions: { headerShown: false },
  screens: {
    Access: createNativeStackScreen({ screen: NativeIdentityScreen }),
    ConnectionsNew: createNativeStackScreen({
      screen: ConnectionsNewRouteScreen,
      options: { headerShown: true, title: "Add a machine", gestureEnabled: true },
    }),
  },
});

const LockedNavigation = createStaticNavigation(LockedStack);
const WorkspaceNavigation = createStaticNavigation(RootStack);

function LaunchSurface() {
  const foreground = useThemeColor("--color-foreground");
  return (
    <View className="flex-1 items-center justify-center bg-screen">
      <Image
        source={logo}
        contentFit="contain"
        tintColor={foreground as string}
        accessibilityLabel="Ryco is loading"
        style={{ width: 128, height: 128 }}
      />
    </View>
  );
}

export function AppAccessGate(props: {
  readonly linking: Parameters<typeof WorkspaceNavigation>[0]["linking"];
  readonly theme: Parameters<typeof WorkspaceNavigation>[0]["theme"];
}) {
  const { catalog } = useConnectionRegistry();
  const hostedAuthenticated = useHostedHubStore((state) => state.accountStatus === "authenticated");
  const [hostedHydrated, setHostedHydrated] = useState(false);
  const [directHydrated, setDirectHydrated] = useState(false);
  const [directCredentialReadable, setDirectCredentialReadable] = useState(false);
  const pendingWorkspaceLink = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    // The hosted plane decides when its launch check settles, or at the launch
    // deadline if the Hub is not answering: a stalled request would otherwise
    // keep the launch surface up for its whole request deadline. The check
    // keeps running, and a revalidated session still unlocks the moment it is
    // published (`hostedAuthenticated` below).
    const deadline = setTimeout(() => {
      if (active) setHostedHydrated(true);
    }, HOSTED_LAUNCH_DECISION_DEADLINE_MS);
    void ensureMobileHostedSession().finally(() => {
      clearTimeout(deadline);
      if (active) setHostedHydrated(true);
    });
    return () => {
      active = false;
      clearTimeout(deadline);
    };
  }, []);

  useEffect(
    () =>
      watchDirectCredentialAccess(catalog, (readable) => {
        setDirectCredentialReadable(readable);
        setDirectHydrated(true);
      }),
    [catalog],
  );

  const access = deriveAppAccess({
    hostedHydrated,
    hostedSessionRevalidated: hostedAuthenticated,
    directHydrated,
    directCredentialReadable,
  });

  useEffect(() => {
    if (access.status !== "hydrating") markAppAccessDecided();
  }, [access.status]);

  useEffect(() => {
    let active = true;
    const capture = (url: string | null) => {
      if (
        active &&
        access.status !== "unlocked" &&
        url !== null &&
        isWorkspaceDeepLink(url) &&
        pendingWorkspaceLink.current === null
      ) {
        pendingWorkspaceLink.current = url;
      }
    };
    void Linking.getInitialURL().then(capture);
    const subscription = Linking.addEventListener("url", (event) => capture(event.url));
    return () => {
      active = false;
      subscription.remove();
    };
  }, [access.status]);

  useEffect(() => {
    if (access.status !== "unlocked" || pendingWorkspaceLink.current === null) return;
    const url = pendingWorkspaceLink.current;
    pendingWorkspaceLink.current = null;
    const frame = requestAnimationFrame(() => {
      void Linking.openURL(url);
    });
    return () => cancelAnimationFrame(frame);
  }, [access.status]);

  if (access.status === "hydrating") return <LaunchSurface />;
  if (access.status === "locked") {
    return <LockedNavigation linking={props.linking} theme={props.theme} />;
  }
  return (
    <>
      <ServerStateBootstrap />
      <ThreadPriorityRefreshBridge />
      <ThreadAlertsBridge />
      <WorkspaceNavigation linking={props.linking} theme={props.theme} />
    </>
  );
}
