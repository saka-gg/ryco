import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { APP_ICON_VARIANTS, iosAlternateAppIconName } from "@ryco/shared/appIcon";
import { describe, expect, it } from "vitest";

import {
  settingsOf,
  templateProject,
  withTemporaryDirectory,
  type XcodeProject,
} from "./lib/xcodeTestProject";

const require = createRequire(import.meta.url);
const plugin = require("./withIosAlternateAppIcons.cjs") as {
  readonly ALTERNATE_APP_ICONS: ReadonlyArray<string>;
  readonly SOURCE_DIRECTORY: string;
  readonly copyAlternateIcons: (projectRoot: string, iosProjectDirectory: string) => void;
  readonly addAlternateIconsToProject: (
    project: XcodeProject,
    projectName: string,
  ) => XcodeProject & { readonly hasFile: (path: string) => unknown };
};

const MOBILE_ROOT = join(import.meta.dirname, "..");
const iconDocument = (name: string) =>
  join(MOBILE_ROOT, plugin.SOURCE_DIRECTORY, `${name}.icon`, "icon.json");

describe("iOS alternate app icons", () => {
  it("has one Liquid Glass document per alternate variant, named as the app asks for it", () => {
    const expected = APP_ICON_VARIANTS.map(iosAlternateAppIconName).filter(
      (name): name is string => name !== null,
    );
    expect([...plugin.ALTERNATE_APP_ICONS].toSorted()).toEqual(expected.toSorted());
    for (const name of [...plugin.ALTERNATE_APP_ICONS, "AppIcon"]) {
      expect(existsSync(iconDocument(name)), name).toBe(true);
    }
  });

  it("copies the documents into the iOS project", () => {
    withTemporaryDirectory((directory) => {
      plugin.copyAlternateIcons(MOBILE_ROOT, directory);
      for (const name of plugin.ALTERNATE_APP_ICONS) {
        expect(readFileSync(join(directory, `${name}.icon`, "icon.json"))).toEqual(
          readFileSync(iconDocument(name)),
        );
        expect(existsSync(join(directory, `${name}.icon`, "Assets", "R.svg"))).toBe(true);
      }
    });
  });

  it("adds them to the app target's resources and names them as alternate icons", () => {
    withTemporaryDirectory((directory) => {
      mkdirSync(join(directory, "ios"));
      const project = plugin.addAlternateIconsToProject(
        templateProject(join(directory, "ios")),
        "HelloWorld",
      );
      for (const name of plugin.ALTERNATE_APP_ICONS) {
        expect(project.hasFile(`HelloWorld/${name}.icon`), name).toBeTruthy();
      }
      const configurations = Object.values(settingsOf(project, "HelloWorld"));
      expect(configurations.length).toBeGreaterThan(0);
      for (const settings of configurations) {
        expect(settings.ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES).toBe(
          '"AppIcon-dark AppIcon-ember AppIcon-ignition"',
        );
      }
      // Running again (a second prebuild pass) adds nothing twice.
      const files = () => JSON.stringify(project.hash.project.objects.PBXFileReference);
      const before = files();
      plugin.addAlternateIconsToProject(project, "HelloWorld");
      expect(files()).toBe(before);
    });
  });
});
