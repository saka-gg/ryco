import { DEFAULT_HOSTED_APP_ORIGIN } from "../../packages/shared/src/hostedApp.ts";
import type { ExpoConfig } from "expo/config";

import { loadMobileEnv, resolveAppVariant, type AppVariant } from "./config/env.ts";

// Ryco public mobile scaffold (B1). The upstream hosted-auth vendor plane and
// managed-cloud plane, its EAS project/owner, upstream bundle IDs/schemes, brand
// assets, the default telemetry endpoint, widgets, share extension, quick
// actions, and the camera-showcase rig are all stripped per the design spec's
// strip list. Direct-node bearer pairing is one auth plane; the hosted plane
// uses a system-browser public-client handoff and defaults to Ryco Cloud.
const repoEnv = loadMobileEnv();
Object.assign(process.env, repoEnv);

const APP_VARIANT = resolveAppVariant(repoEnv.APP_VARIANT);

// Local, capability-reduced device builds (free Apple Personal Team) can only
// sign their own bundle id; expose an override so `expo run:ios` on a device
// does not fail signing. Optional and off by default.
const isIosPersonalTeamBuild = repoEnv.RYCO_IOS_PERSONAL_TEAM === "1";
const personalTeamBundleIdentifier = repoEnv.RYCO_IOS_PERSONAL_TEAM_BUNDLE_ID?.trim();
const IOS_BUNDLE_IDENTIFIER_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

if (
  isIosPersonalTeamBuild &&
  (!personalTeamBundleIdentifier ||
    !IOS_BUNDLE_IDENTIFIER_PATTERN.test(personalTeamBundleIdentifier))
) {
  throw new Error(
    "RYCO_IOS_PERSONAL_TEAM_BUNDLE_ID must be a reverse-DNS identifier such as dev.ryco.app.local when RYCO_IOS_PERSONAL_TEAM=1.",
  );
}

// Reverse-DNS identifiers for the canonical hosted origin app.ryco.space.
const VARIANT_CONFIG: Record<
  AppVariant,
  {
    readonly appName: string;
    readonly scheme: string;
    readonly iosBundleIdentifier: string;
    readonly androidPackage: string;
    readonly relyingParty: string;
    readonly androidNotificationColor: string;
    readonly splashDark: string;
  }
> = {
  development: {
    appName: "Ryco Dev",
    scheme: "ryco-dev",
    iosBundleIdentifier: "dev.ryco.app.dev",
    androidPackage: "dev.ryco.app.dev",
    relyingParty: "app.ryco.space",
    androidNotificationColor: "#00639B",
    splashDark: "#0a0a0a",
  },
  preview: {
    appName: "Ryco Preview",
    scheme: "ryco-preview",
    iosBundleIdentifier: "dev.ryco.app.preview",
    androidPackage: "dev.ryco.app.preview",
    relyingParty: "app.ryco.space",
    androidNotificationColor: "#7565C7",
    splashDark: "#0a0a0a",
  },
  production: {
    appName: "Ryco",
    scheme: "ryco",
    iosBundleIdentifier: "dev.ryco.app",
    androidPackage: "dev.ryco.app",
    relyingParty: "app.ryco.space",
    androidNotificationColor: "#FFFFFF",
    splashDark: "#0a0a0a",
  },
};

const variant = VARIANT_CONFIG[APP_VARIANT];
const iosBundleIdentifier = isIosPersonalTeamBuild
  ? personalTeamBundleIdentifier!
  : variant.iosBundleIdentifier;

// The relying party is the host that serves the association documents, so it is
// deployment metadata, not a build constant: a staging Hub on its own domain
// needs its own RP id. It must equal the Hub's configured `RYCO_HUB_WEBAUTHN_RP_ID`,
// because that is the host the passkey ceremony resolves `webcredentials:`
// against. Defaults to the canonical hosted origin.
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
const relyingPartyOverride = repoEnv.EXPO_PUBLIC_RYCO_RELYING_PARTY?.trim();

if (relyingPartyOverride !== undefined && relyingPartyOverride !== "") {
  if (!HOST_PATTERN.test(relyingPartyOverride)) {
    throw new Error(
      `EXPO_PUBLIC_RYCO_RELYING_PARTY must be a bare hostname such as app.ryco.space — received ${JSON.stringify(relyingPartyOverride)}. It is a WebAuthn RP id, so it carries no scheme, port, or path.`,
    );
  }
}

const relyingParty =
  relyingPartyOverride !== undefined && relyingPartyOverride !== ""
    ? relyingPartyOverride
    : variant.relyingParty;

// Aliases match the fonts' PostScript names on iOS; register the same names on
// Android so RN and the native composer share one family-name set.
const dmSansFonts = {
  regular: "@expo-google-fonts/dm-sans/400Regular/DMSans_400Regular.ttf",
  medium: "@expo-google-fonts/dm-sans/500Medium/DMSans_500Medium.ttf",
  bold: "@expo-google-fonts/dm-sans/700Bold/DMSans_700Bold.ttf",
} as const;

// Apple Developer Team id is deployment metadata (owner-supplied via env);
// never hardcode a team id in the public scaffold.
const appleTeamId = repoEnv.RYCO_IOS_APPLE_TEAM_ID?.trim();

// Hosted Hub plane. `EXPO_PUBLIC_RYCO_HUB_URL` must be the Hub's *public origin*
// (the host that serves the API and the relay upgrade), because every DPoP proof
// signs `htu` against that origin. `EXPO_PUBLIC_RYCO_HUB_APP_URL` is optional
// hosted-web metadata; native authorization starts from the Hub API itself.
const hostedHubBaseUrl = repoEnv.EXPO_PUBLIC_RYCO_HUB_URL?.trim() || DEFAULT_HOSTED_APP_ORIGIN;
const hostedHubAppUrl = repoEnv.EXPO_PUBLIC_RYCO_HUB_APP_URL?.trim() || hostedHubBaseUrl;

// Fail closed at config time on malformed deployment metadata. A Personal Team
// build intentionally omits associated-domain entitlements and still supports
// hosted sign-in through the custom-scheme system-browser handoff.
if (hostedHubBaseUrl) {
  // A Hub on a domain that the relying party does not cover can never serve the
  // association documents the ceremony reads, and that failure is only visible
  // on a device at passkey time — so surface it here instead. The RP id must be
  // the Hub's host or a registrable parent of it.
  const hubHost = (() => {
    try {
      return new URL(hostedHubBaseUrl).hostname;
    } catch {
      throw new Error(
        `EXPO_PUBLIC_RYCO_HUB_URL must be an absolute URL — received ${JSON.stringify(hostedHubBaseUrl)}.`,
      );
    }
  })();
  if (hubHost !== relyingParty && !hubHost.endsWith(`.${relyingParty}`)) {
    throw new Error(
      `EXPO_PUBLIC_RYCO_RELYING_PARTY (${relyingParty}) must equal the Hub host (${hubHost}) or a registrable parent of it, and must match the Hub's RYCO_HUB_WEBAUTHN_RP_ID. Otherwise the passkey ceremony resolves webcredentials: against a host that serves no association document.`,
    );
  }
}

const config: ExpoConfig = {
  name: variant.appName,
  slug: "ryco-mobile",
  platforms: ["ios", "android"],
  scheme: variant.scheme,
  version: "0.1.0",
  runtimeVersion: {
    // Fingerprint (not appVersion) so an OTA only reaches binaries whose native
    // project — native deps, config plugins, AND patches/ — matches the update.
    policy: process.env.MOBILE_VERSION_POLICY ?? "fingerprint",
  },
  orientation: "portrait",
  icon: "./assets/icon.png",
  // Dark-by-default (§4). The runtime resolver (src/lib/appScheme.ts) is the seam
  // a future appearance preference plugs into; this forces the native shell dark so
  // first paint (splash + system chrome) is dark before JS resolves.
  userInterfaceStyle: "dark",
  // OTA updates are disabled in the public scaffold: no EAS project id is
  // baked in. B3 wires the Ryco EAS project + update URL.
  updates: {
    enabled: false,
  },
  ios: {
    icon: "./assets/icon.png",
    supportsTablet: true,
    bundleIdentifier: iosBundleIdentifier,
    ...(appleTeamId ? { appleTeamId } : {}),
    // Paid/team builds may keep native passkey and universal-link support.
    // Personal Team builds omit this entitlement; hosted browser sign-in uses
    // the app's custom scheme and remains available.
    ...(!isIosPersonalTeamBuild && appleTeamId && hostedHubBaseUrl
      ? {
          associatedDomains: [`applinks:${relyingParty}`, `webcredentials:${relyingParty}`],
        }
      : {}),
    infoPlist: {
      NSAppTransportSecurity: {
        // Allow LAN/tailnet connections to a local or staging node over http.
        NSAllowsArbitraryLoads: true,
      },
      NSLocalNetworkUsageDescription:
        "Allow Ryco to connect to Ryco nodes on your local network or tailnet.",
      ITSAppUsesNonExemptEncryption: false,
      // expo-dev-menu floats its own draggable gear FAB, on by default, in the
      // same corner as Home's new-task button. Two overlapping circles make
      // every dev-build screenshot ambiguous. The dev menu is still reachable by
      // shake and by the ⌘D / ⌘M keyboard shortcut.
      EXDevMenuShowFloatingActionButton: false,
    },
  },
  android: {
    icon: "./assets/icon.png",
    package: variant.androidPackage,
    adaptiveIcon: {
      backgroundColor: "#000000",
      foregroundImage: "./assets/adaptive-icon.png",
      monochromeImage: "./assets/android-icon-mark.png",
    },
    predictiveBackGestureEnabled: true,
    // App Links for the relying party host: `autoVerify` makes Android verify
    // this package against the host's /.well-known/assetlinks.json, which is the
    // same document Credential Manager checks for passkeys.
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        category: ["BROWSABLE", "DEFAULT"],
        data: [{ scheme: "https", host: relyingParty }],
      },
    ],
  },
  web: {
    favicon: "./assets/icon.png",
  },
  plugins: [
    "expo-asset",
    "expo-image",
    [
      "expo-font",
      {
        ios: {
          fonts: [dmSansFonts.regular, dmSansFonts.medium, dmSansFonts.bold],
        },
        android: {
          fonts: [
            {
              fontFamily: "DMSans-Regular",
              fontDefinitions: [{ path: dmSansFonts.regular, weight: 400 }],
            },
            {
              fontFamily: "DMSans-Medium",
              fontDefinitions: [{ path: dmSansFonts.medium, weight: 500 }],
            },
            {
              fontFamily: "DMSans-Bold",
              fontDefinitions: [{ path: dmSansFonts.bold, weight: 700 }],
            },
          ],
        },
      },
    ],
    [
      "expo-secure-store",
      {
        // This app owns its Android backup rules
        // (./plugins/withAndroidSecureStoreBackupExclusion.cjs). The library's
        // own rules open with `<include domain="sharedpref" path="."/>`, which
        // turns Auto Backup into an allow-list and would silently stop backing
        // up the SQLite-backed environment registry and the hub profile.
        configureAndroidBackup: false,
      },
    ],
    "expo-sqlite",
    [
      "expo-notifications",
      {
        icon: "./assets/android-notification-icon.png",
        color: variant.androidNotificationColor,
        mode: APP_VARIANT === "development" ? "development" : "production",
      },
    ],
    "expo-web-browser",
    "expo-video",
    [
      "expo-camera",
      {
        cameraPermission: "Allow Ryco to access your camera so you can scan pairing QR codes.",
        barcodeScannerEnabled: true,
        recordAudioAndroid: false,
      },
    ],
    [
      "expo-splash-screen",
      {
        image: "./assets/splash-icon.png",
        resizeMode: "contain",
        // Dark-by-default: first paint is the dark ground (§4), matching --color-screen.
        backgroundColor: "#0a0a0a",
        imageWidth: 220,
        dark: {
          image: "./assets/splash-icon.png",
          backgroundColor: variant.splashDark,
        },
      },
    ],
    [
      "expo-build-properties",
      {
        ios: {
          deploymentTarget: "18.0",
        },
      },
    ],
    "./plugins/withIosCocoaPodsUuidCache.cjs",
    "./plugins/withIosSceneLifecycle.cjs",
    ...(isIosPersonalTeamBuild ? ["./plugins/withIosPersonalTeamCapabilities.cjs"] : []),
    "./plugins/withAndroidCleartextTraffic.cjs",
    "./plugins/withAndroidSecureStoreBackupExclusion.cjs",
    "./plugins/withAndroidGradleHeap.cjs",
    "./plugins/withAndroidModernPopupMenu.cjs",
    "./plugins/withAndroidModernAlertDialog.cjs",
    "./plugins/withAndroidPredictiveBackCompat.cjs",
  ],
  extra: {
    appVariant: APP_VARIANT,
    iosPersonalTeamBuild: isIosPersonalTeamBuild,
    // Optional default node origin for local testing; pairing overrides it.
    node: {
      httpBaseUrl: repoEnv.EXPO_PUBLIC_RYCO_HTTP_URL ?? null,
      wsBaseUrl: repoEnv.EXPO_PUBLIC_RYCO_WS_URL ?? null,
    },
    // Hosted plane. Ryco Cloud is ready by default; custom domains override it.
    // (src/platform/config.ts fails closed on anything it cannot validate).
    hosted: {
      hubBaseUrl: hostedHubBaseUrl,
      appUrl: hostedHubAppUrl,
      relyingParty: relyingParty,
    },
  },
};

export default config;
