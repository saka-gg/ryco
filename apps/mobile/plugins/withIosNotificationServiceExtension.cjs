const path = require("node:path");

const {
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
} = require("expo/config-plugins");

const {
  addAppExtensionTarget,
  extensionInfoPlist,
  firstScheme,
  requireBundleIdentifier: requireConfigBundleIdentifier,
  withEasAppExtension,
  writeAppExtensionFiles,
} = require("./lib/appExtensionTarget.cjs");

/**
 * Background push alerts (`docs/push-alerts.md`) need a Notification Service
 * Extension: the Hub sends generic text plus a payload sealed to this device,
 * and only the extension can open it. This adds the `RycoNotificationService`
 * target and the keychain group the app and the extension share for the push
 * key (`modules/ryco-push`).
 *
 * Personal Team builds cannot sign an extension or a shared keychain group, so
 * app.config.ts leaves this plugin out for them; without the group the push
 * module reports itself unavailable and background alerts stay off.
 */
const TARGET_NAME = "RycoNotificationService";
const ACCESS_GROUP_INFO_KEY = "RycoPushKeychainGroup";
const APP_SCHEME_INFO_KEY = "RycoAppScheme";
const MODULE_DIR = path.join(__dirname, "..", "modules", "ryco-push");
/** Sources compiled into the extension; `PushKeyStore.swift` is shared with the app's module. */
const EXTENSION_SOURCES = [
  path.join(MODULE_DIR, "extension", "NotificationService.swift"),
  path.join(MODULE_DIR, "extension", "PushAlertOpener.swift"),
  path.join(MODULE_DIR, "extension", "PushSealOpener.swift"),
  path.join(MODULE_DIR, "ios", "PushKeyStore.swift"),
];
const ENTITLEMENTS_FILE = `${TARGET_NAME}.entitlements`;

function requireBundleIdentifier(config) {
  return requireConfigBundleIdentifier(config, "withIosNotificationServiceExtension");
}

/** The extension's bundle id, under the app's. */
function notificationServiceBundleIdentifier(bundleIdentifier) {
  return `${bundleIdentifier}.${TARGET_NAME}`;
}

/** The keychain group the app and its extension share for the push key. */
function pushKeychainGroup(bundleIdentifier) {
  return `$(AppIdentifierPrefix)${bundleIdentifier}.push`;
}

/**
 * Adds the push group to the app's keychain groups. The first group is where
 * the keychain puts every item saved without a group, so when the app had none
 * its own application-identifier group goes first: its other secrets (session,
 * E2EE keys) stay where they were and out of the extension's reach.
 */
function addPushKeychainGroup(entitlements, bundleIdentifier) {
  const existing = Array.isArray(entitlements["keychain-access-groups"])
    ? entitlements["keychain-access-groups"]
    : [];
  const groups =
    existing.length > 0 ? [...existing] : [`$(AppIdentifierPrefix)${bundleIdentifier}`];
  const push = pushKeychainGroup(bundleIdentifier);
  if (!groups.includes(push)) groups.push(push);
  return { ...entitlements, "keychain-access-groups": groups };
}

/** The extension's Info.plist, with the app's versions (`extensionInfoPlist`). */
function notificationServiceInfoPlist(config) {
  const bundleIdentifier = requireBundleIdentifier(config);
  const scheme = firstScheme(config);
  return extensionInfoPlist(config, {
    CFBundleDisplayName: TARGET_NAME,
    NSExtension: {
      NSExtensionPointIdentifier: "com.apple.usernotifications.service",
      NSExtensionPrincipalClass: "$(PRODUCT_MODULE_NAME).NotificationService",
    },
    [ACCESS_GROUP_INFO_KEY]: pushKeychainGroup(bundleIdentifier),
    ...(scheme === null ? {} : { [APP_SCHEME_INFO_KEY]: scheme }),
  });
}

function notificationServiceEntitlements(bundleIdentifier) {
  return { "keychain-access-groups": [pushKeychainGroup(bundleIdentifier)] };
}

/**
 * Adds the extension target to the app's Xcode project, embeds it in the app
 * and makes the app depend on it. A project that has it already is left alone.
 */
function addNotificationServiceTarget(project, options) {
  return addAppExtensionTarget(project, {
    targetName: TARGET_NAME,
    bundleIdentifier: notificationServiceBundleIdentifier(options.bundleIdentifier),
    sources: EXTENSION_SOURCES.map((source) => path.basename(source)),
    entitlementsFile: ENTITLEMENTS_FILE,
    appleTeamId: options.appleTeamId,
  });
}

/** Writes the extension's sources, Info.plist and entitlements into `ios/RycoNotificationService`. */
function writeNotificationServiceFiles(platformProjectRoot, config) {
  writeAppExtensionFiles(platformProjectRoot, {
    targetName: TARGET_NAME,
    sources: EXTENSION_SOURCES,
    infoPlist: notificationServiceInfoPlist(config),
    entitlementsFile: ENTITLEMENTS_FILE,
    entitlements: notificationServiceEntitlements(requireBundleIdentifier(config)),
  });
}

const withIosNotificationServiceExtension = (config) => {
  const bundleIdentifier = requireBundleIdentifier(config);

  // EAS Build signs only the extensions the config names (`withEasAppExtension`).
  config = withEasAppExtension(config, {
    targetName: TARGET_NAME,
    bundleIdentifier: notificationServiceBundleIdentifier(bundleIdentifier),
    entitlements: notificationServiceEntitlements(bundleIdentifier),
  });
  config = withEntitlementsPlist(config, (modConfig) => {
    modConfig.modResults = addPushKeychainGroup(modConfig.modResults, bundleIdentifier);
    return modConfig;
  });
  config = withInfoPlist(config, (modConfig) => {
    modConfig.modResults[ACCESS_GROUP_INFO_KEY] = pushKeychainGroup(bundleIdentifier);
    return modConfig;
  });
  config = withDangerousMod(config, [
    "ios",
    (modConfig) => {
      writeNotificationServiceFiles(modConfig.modRequest.platformProjectRoot, modConfig);
      return modConfig;
    },
  ]);
  return withXcodeProject(config, (modConfig) => {
    modConfig.modResults = addNotificationServiceTarget(modConfig.modResults, {
      bundleIdentifier,
      appleTeamId: modConfig.ios?.appleTeamId,
    });
    return modConfig;
  });
};

module.exports = withIosNotificationServiceExtension;
module.exports.TARGET_NAME = TARGET_NAME;
module.exports.addPushKeychainGroup = addPushKeychainGroup;
module.exports.addNotificationServiceTarget = addNotificationServiceTarget;
module.exports.notificationServiceEntitlements = notificationServiceEntitlements;
module.exports.notificationServiceInfoPlist = notificationServiceInfoPlist;
module.exports.writeNotificationServiceFiles = writeNotificationServiceFiles;
