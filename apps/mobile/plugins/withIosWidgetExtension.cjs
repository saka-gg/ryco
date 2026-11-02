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
  requireBundleIdentifier: requireConfigBundleIdentifier,
  withEasAppExtension,
  writeAppExtensionFiles,
} = require("./lib/appExtensionTarget.cjs");

/**
 * Home and Lock Screen widgets need a WidgetKit extension. This adds the
 * `RycoWidgets` target, written in Swift with no pods: it links only system
 * frameworks, so no React Native or Hermes runs in it. The app computes every
 * timeline in TypeScript and writes it as JSON into an App Group both share
 * (`modules/ryco-widgets`); the extension only reads and renders it.
 *
 * Personal Team builds cannot sign an extension or an App Group, so
 * app.config.ts leaves this plugin out for them; without the group the widgets
 * module reports itself unavailable and the app writes nothing.
 */
const TARGET_NAME = "RycoWidgets";
const APP_GROUP_INFO_KEY = "RycoWidgetsAppGroup";
const APP_GROUPS_ENTITLEMENT = "com.apple.security.application-groups";
const MODULE_DIR = path.join(__dirname, "..", "modules", "ryco-widgets");
/**
 * Sources compiled into the extension; `WidgetGroupStore.swift` and the agent
 * Live Activity's attributes and content state are shared with the app's module.
 */
const EXTENSION_SOURCES = [
  path.join(MODULE_DIR, "extension", "AgentActivityWidget.swift"),
  path.join(MODULE_DIR, "extension", "RycoWidgetsBundle.swift"),
  path.join(MODULE_DIR, "extension", "SubscriptionUsageContent.swift"),
  path.join(MODULE_DIR, "extension", "SubscriptionUsageWidget.swift"),
  path.join(MODULE_DIR, "extension", "WidgetTimelineStore.swift"),
  path.join(MODULE_DIR, "ios", "AgentActivityAttributes.swift"),
  path.join(MODULE_DIR, "ios", "AgentActivityContentState.swift"),
  path.join(MODULE_DIR, "ios", "WidgetGroupStore.swift"),
];
const ENTITLEMENTS_FILE = `${TARGET_NAME}.entitlements`;
/** WidgetKit's App Intent configuration and container backgrounds need iOS 17. */
const MINIMUM_DEPLOYMENT_TARGET = "17.0";
/**
 * The extension's Swift module. Not `RycoWidgets`: that is the app's widgets
 * pod (`modules/ryco-widgets/ios`), and the app would find the extension's
 * module of the same name first and miss `RycoWidgetsModule`.
 */
const MODULE_NAME = "RycoWidgetsExtension";

function requireBundleIdentifier(config) {
  return requireConfigBundleIdentifier(config, "withIosWidgetExtension");
}

/** The extension's bundle id, under the app's. */
function widgetsBundleIdentifier(bundleIdentifier) {
  return `${bundleIdentifier}.${TARGET_NAME}`;
}

/** The App Group the app writes timelines to and the extension reads them from. */
function widgetsAppGroup(bundleIdentifier) {
  return `group.${bundleIdentifier}`;
}

/** Adds the widgets group to the app's App Groups; every other entitlement stays as it was. */
function addWidgetsAppGroup(entitlements, bundleIdentifier) {
  const existing = Array.isArray(entitlements[APP_GROUPS_ENTITLEMENT])
    ? entitlements[APP_GROUPS_ENTITLEMENT]
    : [];
  const group = widgetsAppGroup(bundleIdentifier);
  return {
    ...entitlements,
    [APP_GROUPS_ENTITLEMENT]: existing.includes(group) ? [...existing] : [...existing, group],
  };
}

/** The extension holds only the shared group: no keychain group, no push. */
function widgetsEntitlements(bundleIdentifier) {
  return { [APP_GROUPS_ENTITLEMENT]: [widgetsAppGroup(bundleIdentifier)] };
}

/**
 * The keys the app's own Info.plist gets: the group, so its module finds it,
 * and Live Activity support, which the extension renders. iOS then offers a
 * Live Activities switch for Ryco; the app starts one only once its own
 * setting is on.
 */
function addWidgetsAppInfoPlistKeys(infoPlist, bundleIdentifier) {
  return {
    ...infoPlist,
    [APP_GROUP_INFO_KEY]: widgetsAppGroup(bundleIdentifier),
    NSSupportsLiveActivities: true,
  };
}

/** The extension's Info.plist, with the app's versions (`extensionInfoPlist`). */
function widgetsInfoPlist(config) {
  const bundleIdentifier = requireBundleIdentifier(config);
  return extensionInfoPlist(config, {
    CFBundleDisplayName: typeof config.name === "string" ? config.name : TARGET_NAME,
    NSExtension: { NSExtensionPointIdentifier: "com.apple.widgetkit-extension" },
    [APP_GROUP_INFO_KEY]: widgetsAppGroup(bundleIdentifier),
  });
}

/** Adds the extension target to the app's Xcode project, embedded in the app; once. */
function addWidgetsTarget(project, options) {
  return addAppExtensionTarget(project, {
    targetName: TARGET_NAME,
    bundleIdentifier: widgetsBundleIdentifier(options.bundleIdentifier),
    sources: EXTENSION_SOURCES.map((source) => path.basename(source)),
    entitlementsFile: ENTITLEMENTS_FILE,
    appleTeamId: options.appleTeamId,
    minimumDeploymentTarget: MINIMUM_DEPLOYMENT_TARGET,
    moduleName: MODULE_NAME,
  });
}

/** Writes the extension's sources, Info.plist and entitlements into `ios/RycoWidgets`. */
function writeWidgetsFiles(platformProjectRoot, config) {
  writeAppExtensionFiles(platformProjectRoot, {
    targetName: TARGET_NAME,
    sources: EXTENSION_SOURCES,
    infoPlist: widgetsInfoPlist(config),
    entitlementsFile: ENTITLEMENTS_FILE,
    entitlements: widgetsEntitlements(requireBundleIdentifier(config)),
  });
}

const withIosWidgetExtension = (config) => {
  const bundleIdentifier = requireBundleIdentifier(config);

  // EAS Build signs only the extensions the config names, and gives each the
  // capabilities its entitlements list (here the App Group).
  config = withEasAppExtension(config, {
    targetName: TARGET_NAME,
    bundleIdentifier: widgetsBundleIdentifier(bundleIdentifier),
    entitlements: widgetsEntitlements(bundleIdentifier),
  });
  config = withEntitlementsPlist(config, (modConfig) => {
    modConfig.modResults = addWidgetsAppGroup(modConfig.modResults, bundleIdentifier);
    return modConfig;
  });
  config = withInfoPlist(config, (modConfig) => {
    modConfig.modResults = addWidgetsAppInfoPlistKeys(modConfig.modResults, bundleIdentifier);
    return modConfig;
  });
  config = withDangerousMod(config, [
    "ios",
    (modConfig) => {
      writeWidgetsFiles(modConfig.modRequest.platformProjectRoot, modConfig);
      return modConfig;
    },
  ]);
  return withXcodeProject(config, (modConfig) => {
    modConfig.modResults = addWidgetsTarget(modConfig.modResults, {
      bundleIdentifier,
      appleTeamId: modConfig.ios?.appleTeamId,
    });
    return modConfig;
  });
};

module.exports = withIosWidgetExtension;
module.exports.TARGET_NAME = TARGET_NAME;
module.exports.EXTENSION_SOURCES = EXTENSION_SOURCES;
module.exports.addWidgetsAppGroup = addWidgetsAppGroup;
module.exports.addWidgetsAppInfoPlistKeys = addWidgetsAppInfoPlistKeys;
module.exports.addWidgetsTarget = addWidgetsTarget;
module.exports.widgetsEntitlements = widgetsEntitlements;
module.exports.widgetsInfoPlist = widgetsInfoPlist;
module.exports.writeWidgetsFiles = writeWidgetsFiles;
