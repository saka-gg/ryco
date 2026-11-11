const fs = require("node:fs");
const path = require("node:path");

const { IOSConfig, withDangerousMod, withXcodeProject } = require("expo/config-plugins");

/**
 * Ryco's alternate app icons (Settings → Appearance → App icon), as Liquid Glass icons.
 *
 * Each is an Icon Composer document (`assets/app-icons/<name>.icon`, from
 * `scripts/generate-app-icon-variants.py`) beside the primary `AppIcon.icon` that `ios.icon`
 * names. The documents join the app target's resources, and the target names them in
 * `ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES`; actool then compiles them into the asset
 * catalog and writes `CFBundleAlternateIcons` into the built Info.plist itself. The names follow
 * `iosAlternateAppIconName` (`@ryco/shared/appIcon`), which `UIApplication.setAlternateIconName`
 * receives.
 */
const ALTERNATE_APP_ICONS = ["AppIcon-dark", "AppIcon-ember", "AppIcon-ignition"];

const SOURCE_DIRECTORY = "assets/app-icons";

function copyAlternateIcons(projectRoot, iosProjectDirectory) {
  for (const name of ALTERNATE_APP_ICONS) {
    const target = path.join(iosProjectDirectory, `${name}.icon`);
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(path.join(projectRoot, SOURCE_DIRECTORY, `${name}.icon`), target, {
      recursive: true,
    });
  }
}

/** Adds the documents to the app target's resources and names them as alternate icons. */
function addAlternateIconsToProject(project, projectName) {
  for (const name of ALTERNATE_APP_ICONS) {
    const filepath = `${projectName}/${name}.icon`;
    if (project.hasFile(filepath)) continue;
    IOSConfig.XcodeUtils.addResourceFileToGroup({
      filepath,
      groupName: projectName,
      project,
      isBuildFile: true,
    });
  }
  const { target } = IOSConfig.XcodeUtils.getApplicationNativeTarget({ project, projectName });
  const objects = project.hash.project.objects;
  const list = objects.XCConfigurationList[target.buildConfigurationList];
  const names = `"${ALTERNATE_APP_ICONS.join(" ")}"`;
  for (const { value } of list.buildConfigurations) {
    const settings = objects.XCBuildConfiguration[value].buildSettings;
    settings.ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES = names;
  }
  return project;
}

function withIosAlternateAppIcons(config) {
  config = withDangerousMod(config, [
    "ios",
    (modConfig) => {
      const { projectRoot, platformProjectRoot, projectName } = modConfig.modRequest;
      copyAlternateIcons(projectRoot, path.join(platformProjectRoot, projectName));
      return modConfig;
    },
  ]);
  return withXcodeProject(config, (modConfig) => {
    addAlternateIconsToProject(modConfig.modResults, modConfig.modRequest.projectName);
    return modConfig;
  });
}

module.exports = withIosAlternateAppIcons;
module.exports.ALTERNATE_APP_ICONS = ALTERNATE_APP_ICONS;
module.exports.SOURCE_DIRECTORY = SOURCE_DIRECTORY;
module.exports.copyAlternateIcons = copyAlternateIcons;
module.exports.addAlternateIconsToProject = addAlternateIconsToProject;
