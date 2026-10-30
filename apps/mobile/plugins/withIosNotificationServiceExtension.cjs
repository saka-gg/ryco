const fs = require("node:fs");
const path = require("node:path");

const {
  IOSConfig,
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
} = require("expo/config-plugins");
const { createRequire } = require("node:module");
const expoRequire = createRequire(require.resolve("expo/config-plugins"));
const plist = expoRequire("@expo/plist").default;

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
const INFO_PLIST_FILE = "Info.plist";

function requireBundleIdentifier(config) {
  const bundleIdentifier = config.ios?.bundleIdentifier;
  if (typeof bundleIdentifier !== "string" || bundleIdentifier.length === 0) {
    throw new Error("withIosNotificationServiceExtension needs ios.bundleIdentifier.");
  }
  return bundleIdentifier;
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

function firstScheme(config) {
  const scheme = Array.isArray(config.scheme) ? config.scheme[0] : config.scheme;
  return typeof scheme === "string" && scheme.length > 0 ? scheme : null;
}

/**
 * The extension's Info.plist. App Store Connect refuses an extension whose
 * versions differ from its app's, so they come from Expo's own getters, the
 * ones that write the app's Info.plist. A build number EAS assigns at build
 * time (remote versioning, auto-increment) is written into every signed
 * target's Info.plist, this one included once `extra.eas` names it below.
 */
function notificationServiceInfoPlist(config) {
  const bundleIdentifier = requireBundleIdentifier(config);
  const scheme = firstScheme(config);
  return {
    CFBundleDevelopmentRegion: "$(DEVELOPMENT_LANGUAGE)",
    CFBundleDisplayName: TARGET_NAME,
    CFBundleExecutable: "$(EXECUTABLE_NAME)",
    CFBundleIdentifier: "$(PRODUCT_BUNDLE_IDENTIFIER)",
    CFBundleInfoDictionaryVersion: "6.0",
    CFBundleName: "$(PRODUCT_NAME)",
    CFBundlePackageType: "$(PRODUCT_BUNDLE_PACKAGE_TYPE)",
    CFBundleShortVersionString: IOSConfig.Version.getVersion(config),
    CFBundleVersion: IOSConfig.Version.getBuildNumber(config),
    NSExtension: {
      NSExtensionPointIdentifier: "com.apple.usernotifications.service",
      NSExtensionPrincipalClass: "$(PRODUCT_MODULE_NAME).NotificationService",
    },
    [ACCESS_GROUP_INFO_KEY]: pushKeychainGroup(bundleIdentifier),
    ...(scheme === null ? {} : { [APP_SCHEME_INFO_KEY]: scheme }),
  };
}

function notificationServiceEntitlements(bundleIdentifier) {
  return { "keychain-access-groups": [pushKeychainGroup(bundleIdentifier)] };
}

/**
 * EAS Build creates provisioning profiles only for the app extensions the app
 * config names in `extra.eas.build.experimental.ios.appExtensions`; without
 * this entry the extension has no profile on the builder and cannot be signed.
 */
function withEasAppExtension(config, bundleIdentifier) {
  const eas = config.extra?.eas ?? {};
  const ios = eas.build?.experimental?.ios ?? {};
  const appExtensions = (Array.isArray(ios.appExtensions) ? ios.appExtensions : []).filter(
    (extension) => extension?.targetName !== TARGET_NAME,
  );
  appExtensions.push({
    targetName: TARGET_NAME,
    bundleIdentifier: notificationServiceBundleIdentifier(bundleIdentifier),
    entitlements: notificationServiceEntitlements(bundleIdentifier),
  });
  return {
    ...config,
    extra: {
      ...config.extra,
      eas: {
        ...eas,
        build: {
          ...eas.build,
          experimental: { ...eas.build?.experimental, ios: { ...ios, appExtensions } },
        },
      },
    },
  };
}

function quoted(value) {
  return `"${value}"`;
}

function unquoted(value) {
  return typeof value === "string" ? value.replace(/^"(.*)"$/u, "$1") : value;
}

/** `addPbxGroup` gives every file a build file; the plist and entitlements are never built. */
function removeBuildFiles(project, fileNames) {
  const buildFiles = project.hash.project.objects.PBXBuildFile;
  for (const key of Object.keys(buildFiles)) {
    const entry = buildFiles[key];
    if (typeof entry !== "object" || !fileNames.includes(unquoted(entry.fileRef_comment))) continue;
    delete buildFiles[key];
    delete buildFiles[`${key}_comment`];
  }
}

/** The `xcode` package leaves unset fields as `undefined`, which it would write out literally. */
function dropUndefinedFields(project) {
  const objects = project.hash.project.objects;
  for (const section of [objects.PBXFileReference, objects.PBXBuildFile]) {
    for (const entry of Object.values(section ?? {})) {
      if (typeof entry !== "object" || entry === null) continue;
      for (const [field, value] of Object.entries(entry)) {
        if (value === undefined) delete entry[field];
      }
    }
  }
}

/** The app target's deployment target, so the extension never asks for more. */
function appDeploymentTarget(project) {
  const configurations = project.pbxXCBuildConfigurationSection();
  for (const key of Object.keys(configurations)) {
    const settings = configurations[key]?.buildSettings;
    if (settings?.IPHONEOS_DEPLOYMENT_TARGET && settings.PRODUCT_NAME !== quoted(TARGET_NAME)) {
      return unquoted(settings.IPHONEOS_DEPLOYMENT_TARGET);
    }
  }
  return "18.0";
}

/**
 * Adds the extension target to the app's Xcode project, embeds it in the app
 * and makes the app depend on it. A project that has it already is left alone.
 */
function addNotificationServiceTarget(project, options) {
  if (project.pbxTargetByName(TARGET_NAME) || project.pbxTargetByName(quoted(TARGET_NAME))) {
    return project;
  }
  const objects = project.hash.project.objects;
  // `addTarget` records its dependency only when these sections already exist.
  objects.PBXTargetDependency = objects.PBXTargetDependency ?? {};
  objects.PBXContainerItemProxy = objects.PBXContainerItemProxy ?? {};

  const sourceNames = EXTENSION_SOURCES.map((source) => path.basename(source));
  const group = project.addPbxGroup(
    [...sourceNames, INFO_PLIST_FILE, ENTITLEMENTS_FILE],
    TARGET_NAME,
    TARGET_NAME,
  );
  removeBuildFiles(project, [INFO_PLIST_FILE, ENTITLEMENTS_FILE]);
  const mainGroupId = project.getFirstProject().firstProject.mainGroup;
  project.addToPbxGroup(group.uuid, mainGroupId);

  const deploymentTarget = appDeploymentTarget(project);
  const target = project.addTarget(
    TARGET_NAME,
    "app_extension",
    TARGET_NAME,
    notificationServiceBundleIdentifier(options.bundleIdentifier),
  );
  project.addBuildPhase(sourceNames, "PBXSourcesBuildPhase", "Sources", target.uuid);
  project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", target.uuid);
  project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", target.uuid);

  const configurations = project.pbxXCBuildConfigurationSection();
  for (const key of Object.keys(configurations)) {
    const settings = configurations[key]?.buildSettings;
    if (!settings || settings.PRODUCT_NAME !== quoted(TARGET_NAME)) continue;
    Object.assign(settings, {
      CLANG_ENABLE_MODULES: "YES",
      CODE_SIGN_ENTITLEMENTS: quoted(`${TARGET_NAME}/${ENTITLEMENTS_FILE}`),
      CODE_SIGN_STYLE: "Automatic",
      GENERATE_INFOPLIST_FILE: "NO",
      INFOPLIST_FILE: quoted(`${TARGET_NAME}/${INFO_PLIST_FILE}`),
      IPHONEOS_DEPLOYMENT_TARGET: deploymentTarget,
      SWIFT_VERSION: "5.0",
      TARGETED_DEVICE_FAMILY: quoted("1,2"),
      ...(configurations[key].name === "Debug"
        ? {
            SWIFT_OPTIMIZATION_LEVEL: quoted("-Onone"),
            SWIFT_ACTIVE_COMPILATION_CONDITIONS: "DEBUG",
          }
        : {}),
      ...(options.appleTeamId ? { DEVELOPMENT_TEAM: options.appleTeamId } : {}),
    });
  }
  if (options.appleTeamId) {
    project.addTargetAttribute("DevelopmentTeam", options.appleTeamId, target);
  }
  dropUndefinedFields(project);
  return project;
}

/** Writes the extension's sources, Info.plist and entitlements into `ios/RycoNotificationService`. */
function writeNotificationServiceFiles(platformProjectRoot, config) {
  const directory = path.join(platformProjectRoot, TARGET_NAME);
  fs.mkdirSync(directory, { recursive: true });
  for (const source of EXTENSION_SOURCES) {
    fs.copyFileSync(source, path.join(directory, path.basename(source)));
  }
  fs.writeFileSync(
    path.join(directory, INFO_PLIST_FILE),
    plist.build(notificationServiceInfoPlist(config)),
    "utf8",
  );
  fs.writeFileSync(
    path.join(directory, ENTITLEMENTS_FILE),
    plist.build(notificationServiceEntitlements(requireBundleIdentifier(config))),
    "utf8",
  );
}

const withIosNotificationServiceExtension = (config) => {
  const bundleIdentifier = requireBundleIdentifier(config);

  config = withEasAppExtension(config, bundleIdentifier);
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
