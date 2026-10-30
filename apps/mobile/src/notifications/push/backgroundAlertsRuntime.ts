import { getHostedHubApi, hostedHubStore } from "@ryco/client-runtime/authorization";
import {
  createBackgroundAlerts,
  type BackgroundAlerts,
  type BackgroundAlertsAccount,
  type BackgroundAlertsConnection,
} from "@ryco/client-runtime/notifications/push";
import type { EnvironmentConnection } from "@ryco/client-runtime/connection";
import * as Notifications from "expo-notifications";
import { AppState } from "react-native";

import {
  getMobileNativeE2eeEnrollmentState,
  subscribeMobileNativeE2eeEnrollment,
} from "../../hostedHub/e2eeEnrollment";
import { readMobileNativePlatform, readMobilePushBuild } from "../../platform/config";
import { mobileKV } from "../../platform/kv";
import { createMobileConnectionRegistry } from "../../runtime/bootstrap";
import { getPreferencesSnapshot, subscribePreferences } from "../../state/preferencesStore";
import { readThreadAlertPermission } from "../threadAlerts";
import { backgroundAlertsSupport } from "./backgroundAlertsModel";
import { ensureMobilePushKeyCustody, readMobileRycoPush } from "./pushKeyCustody";
import { createPushKeyStore } from "./pushKeyStore";

/** APNs answers a registration within seconds; past this the token counts as unavailable. */
const DEVICE_TOKEN_TIMEOUT_MS = 30_000;
/** The account whose Hub registration was turned off but not removed yet (`docs/push-alerts.md`). */
const HUB_REMOVAL_OWED_KEY = "ryco.push.hubRemovalOwed.v1";

const adapted = new WeakMap<EnvironmentConnection, BackgroundAlertsConnection>();

/** One stable view per connection: background alerts compare them by identity. */
function adaptConnection(connection: EnvironmentConnection): BackgroundAlertsConnection {
  let view = adapted.get(connection);
  if (view === undefined) {
    view = {
      environmentId: connection.environmentId,
      viaHub: connection.knownEnvironment.source === "hub-hosted",
      readReady: () => connection.shellSnapshotReadiness.read(),
      subscribeReady: (listener) => connection.shellSnapshotReadiness.subscribe(listener),
      push: connection.client.push,
    };
    adapted.set(connection, view);
  }
  return view;
}

function readAccount(): BackgroundAlertsAccount {
  const state = hostedHubStore.getState();
  if (state.accountStatus === "signed-out") return { status: "signed-out" };
  if (state.accountStatus !== "authenticated" || state.account === null) {
    return { status: "pending" };
  }
  const enrollment = getMobileNativeE2eeEnrollmentState();
  return {
    status: "signed-in",
    accountId: state.account.id,
    enrollmentId:
      enrollment.status === "ready" ? (enrollment.ready?.enrollment.enrollmentId ?? null) : null,
  };
}

async function readDeviceToken(): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const token = await Promise.race([
      Notifications.getDevicePushTokenAsync(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("APNs gave no device token in time.")),
          DEVICE_TOKEN_TIMEOUT_MS,
        );
      }),
    ]);
    if (typeof token.data !== "string") throw new Error("APNs gave no device token.");
    return token.data.toLowerCase();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function createMobileBackgroundAlerts(): BackgroundAlerts {
  const build = readMobilePushBuild();
  const pushKey = createPushKeyStore(readMobileRycoPush(), ensureMobilePushKeyCustody);
  const supervisor = () => createMobileConnectionRegistry().driver.supervisor;
  return createBackgroundAlerts({
    support: backgroundAlertsSupport({
      platform: readMobileNativePlatform(),
      personalTeamBuild: build.personalTeamBuild,
      keyStoreAvailable: pushKey.available && build.topic !== null,
    }),
    build: {
      platform: "ios",
      topic: build.topic ?? "",
      apnsEnvironment: build.apnsEnvironment,
    },
    preferences: {
      read: () => {
        const preferences = getPreferencesSnapshot();
        return {
          enabled: preferences.threadAlerts === true && preferences.backgroundAlerts === true,
          sound: preferences.threadAlertSound === true,
        };
      },
      subscribe: subscribePreferences,
    },
    account: {
      read: readAccount,
      subscribe: (listener) => {
        const unsubscribeHub = hostedHubStore.subscribe(listener);
        const unsubscribeEnrollment = subscribeMobileNativeE2eeEnrollment(listener);
        return () => {
          unsubscribeHub();
          unsubscribeEnrollment();
        };
      },
    },
    hub: getHostedHubApi,
    connections: {
      list: () => supervisor().list().map(adaptConnection),
      subscribe: (listener) => supervisor().subscribe(listener),
    },
    pushKey,
    hubRemoval: {
      read: () => mobileKV.getItem(HUB_REMOVAL_OWED_KEY),
      write: (accountId) =>
        accountId === null
          ? mobileKV.removeItem(HUB_REMOVAL_OWED_KEY)
          : mobileKV.setItem(HUB_REMOVAL_OWED_KEY, accountId),
    },
    notifications: { readPermission: readThreadAlertPermission, readDeviceToken },
    app: {
      // The same test thread alerts use: whenever they would defer to push,
      // the node must already hear that the app is not in front.
      isActive: () => AppState.currentState === "active",
      subscribe: (listener) => {
        const subscription = AppState.addEventListener("change", listener);
        return () => subscription.remove();
      },
    },
    timers: {
      setInterval: (callback, ms) => setInterval(callback, ms),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    },
    now: Date.now,
    onError: (context, error) => {
      console.warn(context, { error: error instanceof Error ? error.message : String(error) });
    },
  });
}

let instance: BackgroundAlerts | null = null;

/** The app's background alerts, created on first use. */
export function getMobileBackgroundAlerts(): BackgroundAlerts {
  return (instance ??= createMobileBackgroundAlerts());
}
