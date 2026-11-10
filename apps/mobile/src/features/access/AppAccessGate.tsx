import { createStaticNavigation } from "@react-navigation/native";
import {
  createNativeStackNavigator,
  createNativeStackScreen,
} from "@react-navigation/native-stack";
import { Image } from "expo-image";
import * as Linking from "expo-linking";
import { readLaunchURL } from "../../lib/launchUrl";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { View } from "react-native";

import { ConnectionsNewRouteScreen, NativeIdentityScreen } from "../../navigation/lazyRouteScreens";
import {
  deriveRetainedHubSession,
  isHubLaunchCheckSettled,
  readHubSessionConfirmedAt,
  readStoredHubSession,
  subscribeHubLaunchState,
} from "../../hostedHub/retainedSessionAccess";
import { useHostedHubStore, ensureMobileHostedSession } from "../../hostedHub/state";
import { mobileKV } from "../../platform/kv";
import { mobileRuntimeStartupBarrier } from "../../runtime/startupBarrier";
import { useThemeColor } from "../../lib/useThemeColor";
import { useConnectionRegistry } from "../../providers/ConnectionRegistryProvider";
import { RootStack } from "../../Stack";
import { ServerStateBootstrap } from "../../state/serverStateSync";
import { deriveAppAccess, isWorkspaceDeepLink } from "./appAccessModel";
import { watchDirectCredentialAccess } from "./directCredentialAccess";
import {
  HOSTED_LAUNCH_DECISION_DEADLINE_MS,
  markAppAccessDecided,
  SAVED_WORKSPACE_READ_WAIT_MS,
} from "./launchDecision";
import {
  LiveActivityBridge,
  LockedLiveActivityBridge,
} from "../../liveActivity/LiveActivityBridge";
import { ThreadAlertsBridge } from "../../notifications/ThreadAlertsBridge";
import { LockedWidgetsBridge, WidgetsBridge } from "../../widgets/WidgetsBridge";
import { SettingsSharingBridge } from "../settings/sharing/SettingsSharingBridge";

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
  const accountStatus = useHostedHubStore((state) => state.accountStatus);
  const hostedAuthenticated = accountStatus === "authenticated";
  const [hostedHydrated, setHostedHydrated] = useState(false);
  // The launch check itself settled, unlike `hostedHydrated`, which the launch
  // deadline also sets: only then is the account status the check's answer.
  const hostedCheckSettled = useSyncExternalStore(subscribeHubLaunchState, isHubLaunchCheckSettled);
  const storedHubSession = useSyncExternalStore(subscribeHubLaunchState, readStoredHubSession);
  const [hubSessionConfirmedAt, setHubSessionConfirmedAt] = useState<number | null>(null);
  const [savedWorkspaceRead, setSavedWorkspaceRead] = useState(() =>
    mobileRuntimeStartupBarrier.isHydrated(),
  );
  // The retained sign-in's window is measured once, at launch.
  const [launchedAt] = useState(() => Date.now());
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
    // The workspace opens on what is saved on this device, so it waits for
    // that to be read; a retained sign-in also needs the Hub's last confirmation.
    void readHubSessionConfirmedAt(mobileKV).then((confirmedAt) => {
      if (active) setHubSessionConfirmedAt(confirmedAt);
    });
    mobileRuntimeStartupBarrier.runAfterHydration(
      () => {
        if (active) setSavedWorkspaceRead(true);
      },
      () => undefined,
    );
    // A read that takes this long is no longer worth the launch surface: the
    // workspace opens and fills in as the rest of it lands.
    const savedWorkspaceDeadline = setTimeout(() => {
      if (active) setSavedWorkspaceRead(true);
    }, SAVED_WORKSPACE_READ_WAIT_MS);
    return () => {
      active = false;
      clearTimeout(deadline);
      clearTimeout(savedWorkspaceDeadline);
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
    savedWorkspaceRead,
    hostedSessionRetained: deriveRetainedHubSession({
      storedSession: storedHubSession,
      confirmedAt: hubSessionConfirmedAt,
      now: launchedAt,
      accessCheckSettled: hostedCheckSettled,
      accountStatus,
    }),
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
    // Only looks: the navigator consumes the launch URL once it mounts.
    void readLaunchURL({ consume: false }).then(capture);
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
    return (
      <>
        <LockedWidgetsBridge />
        <LockedLiveActivityBridge />
        <LockedNavigation linking={props.linking} theme={props.theme} />
      </>
    );
  }
  return (
    <>
      <ServerStateBootstrap />
      <ThreadAlertsBridge />
      <WidgetsBridge />
      <SettingsSharingBridge />
      <LiveActivityBridge />
      <WorkspaceNavigation linking={props.linking} theme={props.theme} />
    </>
  );
}
