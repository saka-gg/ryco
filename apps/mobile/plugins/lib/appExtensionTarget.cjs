const fs = require("node:fs");
const path = require("node:path");

const { IOSConfig } = require("expo/config-plugins");
const { createRequire } = require("node:module");
const expoRequire = createRequire(require.resolve("expo/config-plugins"));
const plist = expoRequire("@expo/plist").default;

/**
 * What every iOS app extension the config plugins add needs: its own target in
 * the app's Xcode project, embedded in the app; an Info.plist with the app's
 * versions; and the EAS entry that gets it a provisioning profile.
 * `withIosNotificationServiceExtension.cjs` and `withIosWidgetExtension.cjs`
 * are built on it.
 */

const APP_EXTENSION_PRODUCT_TYPE = "com.apple.product-type.app-extension";
/** `PBXCopyFilesBuildPhase.dstSubfolderSpec` for the app's PlugIns folder. */
const PLUGINS_FOLDER_SPEC = 13;
const INFO_PLIST_FILE = "Info.plist";

function requireBundleIdentifier(config, pluginName) {
  const bundleIdentifier = config.ios?.bundleIdentifier;
  if (typeof bundleIdentifier !== "string" || bundleIdentifier.length === 0) {
    throw new Error(`${pluginName} needs ios.bundleIdentifier.`);
  }
  return bundleIdentifier;
}

function firstScheme(config) {
  const scheme = Array.isArray(config.scheme) ? config.scheme[0] : config.scheme;
  return typeof scheme === "string" && scheme.length > 0 ? scheme : null;
}

/**
 * An extension's Info.plist. App Store Connect refuses an extension whose
 * versions differ from its app's, so they come from Expo's own getters, the
 * ones that write the app's Info.plist. A build number EAS assigns at build
 * time (remote versioning, auto-increment) is written into every signed
 * target's Info.plist, an extension's included once `extra.eas` names it
 * (`withEasAppExtension`). `extra` carries `NSExtension` and the extension's own keys.
 */
function extensionInfoPlist(config, extra) {
  return {
    CFBundleDevelopmentRegion: "$(DEVELOPMENT_LANGUAGE)",
    CFBundleExecutable: "$(EXECUTABLE_NAME)",
    CFBundleIdentifier: "$(PRODUCT_BUNDLE_IDENTIFIER)",
    CFBundleInfoDictionaryVersion: "6.0",
    CFBundleName: "$(PRODUCT_NAME)",
    CFBundlePackageType: "$(PRODUCT_BUNDLE_PACKAGE_TYPE)",
    CFBundleShortVersionString: IOSConfig.Version.getVersion(config),
    CFBundleVersion: IOSConfig.Version.getBuildNumber(config),
    ...extra,
  };
}

/**
 * EAS Build creates provisioning profiles only for the app extensions the app
 * config names in `extra.eas.build.experimental.ios.appExtensions`; without
 * its entry an extension has no profile on the builder and cannot be signed.
 * Config is evaluated more than once, so an entry replaces its earlier self.
 */
function withEasAppExtension(config, entry) {
  const eas = config.extra?.eas ?? {};
  const ios = eas.build?.experimental?.ios ?? {};
  const appExtensions = (Array.isArray(ios.appExtensions) ? ios.appExtensions : []).filter(
    (extension) => extension?.targetName !== entry.targetName,
  );
  appExtensions.push(entry);
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

function hasTarget(project, targetName) {
  return Boolean(
    project.pbxTargetByName(targetName) || project.pbxTargetByName(quoted(targetName)),
  );
}

/** The build configurations of every app extension target in the project. */
function extensionConfigurationIds(project) {
  const objects = project.hash.project.objects;
  const ids = new Set();
  for (const target of Object.values(objects.PBXNativeTarget ?? {})) {
    if (typeof target !== "object" || unquoted(target.productType) !== APP_EXTENSION_PRODUCT_TYPE) {
      continue;
    }
    const list = objects.XCConfigurationList?.[target.buildConfigurationList];
    for (const { value } of list?.buildConfigurations ?? []) ids.add(value);
  }
  return ids;
}

/** The app's deployment target (never an extension's), so an extension never asks for less. */
function appDeploymentTarget(project) {
  const extensionConfigurations = extensionConfigurationIds(project);
  const configurations = project.pbxXCBuildConfigurationSection();
  for (const key of Object.keys(configurations)) {
    if (extensionConfigurations.has(key)) continue;
    const settings = configurations[key]?.buildSettings;
    if (settings?.IPHONEOS_DEPLOYMENT_TARGET) return unquoted(settings.IPHONEOS_DEPLOYMENT_TARGET);
  }
  return "18.0";
}

/** The higher of two dotted versions, such as `16.4` and `17.0`. */
function laterVersion(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0 ? left : right;
  }
  return left;
}

const FILE_TYPES = {
  ".swift": "sourcecode.swift",
  ".plist": "text.plist.xml",
  ".entitlements": "text.plist.entitlements",
};

/**
 * A new file reference in the extension's group. The `xcode` package's
 * `addPbxGroup` reuses any reference with the same path, so a second
 * extension's `Info.plist` would point at the first one's; every extension
 * gets references of its own instead.
 */
function addFileReference(project, fileName) {
  const objects = project.hash.project.objects;
  const uuid = project.generateUuid();
  const fileType = FILE_TYPES[path.extname(fileName)];
  if (fileType === undefined) throw new Error(`No Xcode file type for ${fileName}.`);
  objects.PBXFileReference[uuid] = {
    isa: "PBXFileReference",
    lastKnownFileType: fileType,
    path: quoted(fileName),
    sourceTree: quoted("<group>"),
    ...(fileType === "sourcecode.swift" ? { fileEncoding: 4 } : {}),
  };
  objects.PBXFileReference[`${uuid}_comment`] = fileName;
  return uuid;
}

function addBuildFile(project, fileRef, fileName, phaseName) {
  const objects = project.hash.project.objects;
  const uuid = project.generateUuid();
  objects.PBXBuildFile[uuid] = { isa: "PBXBuildFile", fileRef, fileRef_comment: fileName };
  objects.PBXBuildFile[`${uuid}_comment`] = `${fileName} in ${phaseName}`;
  return { value: uuid, comment: `${fileName} in ${phaseName}` };
}

/**
 * The `xcode` package gives the app a new copy phase for every extension
 * target, but puts the product into the first such phase it finds. The app
 * keeps one phase that embeds every extension once; the empty ones go.
 */
function mergeExtensionEmbedPhases(project) {
  const objects = project.hash.project.objects;
  const copyPhases = objects.PBXCopyFilesBuildPhase ?? {};
  const app = project.getFirstTarget().firstTarget;
  const embedPhases = app.buildPhases.filter(
    (phase) => copyPhases[phase.value]?.dstSubfolderSpec === PLUGINS_FOLDER_SPEC,
  );
  if (embedPhases.length === 0) return;
  const [keep, ...rest] = embedPhases;
  const kept = copyPhases[keep.value];
  const seen = new Set(kept.files.map((file) => file.value));
  for (const phase of rest) {
    for (const file of copyPhases[phase.value].files) {
      if (!seen.has(file.value)) kept.files.push(file);
      seen.add(file.value);
    }
    delete copyPhases[phase.value];
    delete copyPhases[`${phase.value}_comment`];
  }
  const dropped = new Set(rest.map((phase) => phase.value));
  app.buildPhases = app.buildPhases.filter((phase) => !dropped.has(phase.value));
}

/**
 * Adds an extension target to the app's Xcode project, embeds it in the app
 * and makes the app depend on it. A project that has it already is left alone.
 *
 * `sources` are the file names of the Swift sources in `ios/<targetName>`;
 * `plistFile` and `entitlementsFile` sit next to them and are never built.
 * `moduleName` renames the target's Swift module, which Xcode writes next to
 * the pods' own: a pod module of the same name would no longer be found.
 */
function addAppExtensionTarget(project, options) {
  const { targetName, bundleIdentifier, sources, entitlementsFile } = options;
  const plistFile = options.plistFile ?? INFO_PLIST_FILE;
  if (hasTarget(project, targetName)) return project;
  const objects = project.hash.project.objects;
  // `addTarget` records its dependency only when these sections already exist.
  objects.PBXTargetDependency = objects.PBXTargetDependency ?? {};
  objects.PBXContainerItemProxy = objects.PBXContainerItemProxy ?? {};

  const references = [...sources, plistFile, entitlementsFile].map((fileName) => ({
    fileName,
    fileRef: addFileReference(project, fileName),
  }));
  const group = project.addPbxGroup([], targetName, targetName);
  group.pbxGroup.children.push(
    ...references.map(({ fileName, fileRef }) => ({ value: fileRef, comment: fileName })),
  );
  const mainGroupId = project.getFirstProject().firstProject.mainGroup;
  project.addToPbxGroup(group.uuid, mainGroupId);

  const deploymentTarget = laterVersion(
    appDeploymentTarget(project),
    options.minimumDeploymentTarget ?? "0",
  );
  const target = project.addTarget(targetName, "app_extension", targetName, bundleIdentifier);
  mergeExtensionEmbedPhases(project);
  const sourcesPhase = project.addBuildPhase([], "PBXSourcesBuildPhase", "Sources", target.uuid);
  sourcesPhase.buildPhase.files.push(
    ...references
      .filter(({ fileName }) => sources.includes(fileName))
      .map(({ fileName, fileRef }) => addBuildFile(project, fileRef, fileName, "Sources")),
  );
  project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", target.uuid);
  project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", target.uuid);

  const configurations = project.pbxXCBuildConfigurationSection();
  for (const key of Object.keys(configurations)) {
    const settings = configurations[key]?.buildSettings;
    if (!settings || settings.PRODUCT_NAME !== quoted(targetName)) continue;
    Object.assign(settings, {
      CLANG_ENABLE_MODULES: "YES",
      CODE_SIGN_ENTITLEMENTS: quoted(`${targetName}/${entitlementsFile}`),
      CODE_SIGN_STYLE: "Automatic",
      GENERATE_INFOPLIST_FILE: "NO",
      INFOPLIST_FILE: quoted(`${targetName}/${plistFile}`),
      IPHONEOS_DEPLOYMENT_TARGET: deploymentTarget,
      ...(options.moduleName ? { PRODUCT_MODULE_NAME: options.moduleName } : {}),
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

/**
 * Writes an extension's sources, Info.plist and entitlements into
 * `ios/<targetName>`, where `addAppExtensionTarget` points its target.
 */
function writeAppExtensionFiles(platformProjectRoot, options) {
  const directory = path.join(platformProjectRoot, options.targetName);
  fs.mkdirSync(directory, { recursive: true });
  for (const source of options.sources) {
    fs.copyFileSync(source, path.join(directory, path.basename(source)));
  }
  fs.writeFileSync(
    path.join(directory, options.plistFile ?? INFO_PLIST_FILE),
    plist.build(options.infoPlist),
    "utf8",
  );
  fs.writeFileSync(
    path.join(directory, options.entitlementsFile),
    plist.build(options.entitlements),
    "utf8",
  );
}

module.exports = {
  INFO_PLIST_FILE,
  addAppExtensionTarget,
  appDeploymentTarget,
  dropUndefinedFields,
  extensionInfoPlist,
  firstScheme,
  requireBundleIdentifier,
  withEasAppExtension,
  writeAppExtensionFiles,
};
