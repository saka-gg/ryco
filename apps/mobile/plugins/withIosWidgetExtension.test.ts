import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  extensionEmbedPhases,
  phaseFiles,
  settingsOf,
  templateProject,
  withTemporaryDirectory,
  type XcodeProject,
} from "./lib/xcodeTestProject";

type ConfigPlugin = (config: Record<string, unknown>) => Record<string, any>;

const require = createRequire(import.meta.url);
const plugin = require("./withIosWidgetExtension.cjs") as ConfigPlugin & {
  readonly TARGET_NAME: string;
  readonly addWidgetsTarget: (
    project: XcodeProject,
    options: { readonly bundleIdentifier: string; readonly appleTeamId?: string },
  ) => XcodeProject;
  readonly widgetsInfoPlist: (config: Record<string, unknown>) => Record<string, unknown>;
  readonly widgetsEntitlements: (bundleIdentifier: string) => Record<string, unknown>;
  readonly writeWidgetsFiles: (
    platformProjectRoot: string,
    config: Record<string, unknown>,
  ) => void;
};
const notificationService = require("./withIosNotificationServiceExtension.cjs") as ConfigPlugin & {
  readonly addNotificationServiceTarget: (
    project: XcodeProject,
    options: { readonly bundleIdentifier: string },
  ) => XcodeProject;
};

const MOBILE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIDGETS_MODULE = join(MOBILE_ROOT, "modules", "ryco-widgets");
const BUNDLE_ID = "dev.ryco.app.dev";
const APP_GROUP = "group.dev.ryco.app.dev";
const CONFIG = {
  name: "Ryco Dev",
  version: "0.1.0",
  scheme: "ryco-dev",
  ios: { bundleIdentifier: BUNDLE_ID, buildNumber: "7" },
};

/** Runs one of the mods a plugin registered, the way prebuild hands it its file. */
async function runMod(
  configured: Record<string, any>,
  modName: "entitlements" | "infoPlist",
  modResults: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await configured.mods.ios[modName]({
    ...configured,
    modResults,
    modRequest: {
      platform: "ios",
      modName,
      introspect: false,
      projectRoot: "/project",
      platformProjectRoot: "/project/ios",
    },
  });
  return result.modResults;
}

describe("the App Group", () => {
  it("joins the app's entitlements and leaves the push environment and keychain groups alone", async () => {
    const configured = plugin(CONFIG);
    const entitlements = {
      "aps-environment": "production",
      "keychain-access-groups": ["$(AppIdentifierPrefix)dev.ryco.app.dev"],
      "com.apple.security.application-groups": ["group.other"],
    };
    expect(await runMod(configured, "entitlements", entitlements)).toEqual({
      "aps-environment": "production",
      "keychain-access-groups": ["$(AppIdentifierPrefix)dev.ryco.app.dev"],
      "com.apple.security.application-groups": ["group.other", APP_GROUP],
    });
    expect(entitlements["com.apple.security.application-groups"]).toEqual(["group.other"]);
    // Prebuild runs the mods once per pass; the group is listed once.
    const twice = await runMod(
      plugin(plugin(CONFIG)),
      "entitlements",
      await runMod(configured, "entitlements", {}),
    );
    expect(twice).toEqual({ "com.apple.security.application-groups": [APP_GROUP] });
  });

  it("is the only entitlement the extension gets", () => {
    expect(plugin.widgetsEntitlements(BUNDLE_ID)).toEqual({
      "com.apple.security.application-groups": [APP_GROUP],
    });
  });

  it("is named in the app's Info.plist, where its module looks for it, beside Live Activities", async () => {
    expect(await runMod(plugin(CONFIG), "infoPlist", { CFBundleName: "Ryco Dev" })).toEqual({
      CFBundleName: "Ryco Dev",
      RycoWidgetsAppGroup: APP_GROUP,
      NSSupportsLiveActivities: true,
    });
  });
});

describe("the extension's Info.plist", () => {
  it("declares a WidgetKit extension with the app's versions and group", () => {
    expect(plugin.widgetsInfoPlist(CONFIG)).toMatchObject({
      CFBundleDisplayName: "Ryco Dev",
      CFBundleShortVersionString: "0.1.0",
      CFBundleVersion: "7",
      NSExtension: { NSExtensionPointIdentifier: "com.apple.widgetkit-extension" },
      RycoWidgetsAppGroup: APP_GROUP,
    });
  });

  it("writes the extension's sources next to its plist and entitlements", () => {
    withTemporaryDirectory((directory) => {
      plugin.writeWidgetsFiles(directory, CONFIG);
      const extension = join(directory, plugin.TARGET_NAME);
      expect(readFileSync(join(extension, "Info.plist"), "utf8")).toContain(
        "com.apple.widgetkit-extension",
      );
      expect(readFileSync(join(extension, "RycoWidgets.entitlements"), "utf8")).toContain(
        APP_GROUP,
      );
      // Every extension source, and what it shares with the app's module.
      const sources = readdirSync(join(WIDGETS_MODULE, "extension"))
        .filter((file) => file.endsWith(".swift"))
        .concat(
          "AgentActivityAttributes.swift",
          "AgentActivityContentState.swift",
          "WidgetGroupStore.swift",
        );
      expect(readdirSync(extension).toSorted()).toEqual(
        [...sources, "Info.plist", "RycoWidgets.entitlements"].toSorted(),
      );
    });
  });
});

describe("EAS Build", () => {
  it("names the extension with its App Group, next to the notification service", () => {
    const configured = plugin(notificationService(plugin(CONFIG)));
    expect(configured.extra.eas.build.experimental.ios.appExtensions).toEqual([
      {
        targetName: "RycoNotificationService",
        bundleIdentifier: "dev.ryco.app.dev.RycoNotificationService",
        entitlements: {
          "keychain-access-groups": ["$(AppIdentifierPrefix)dev.ryco.app.dev.push"],
        },
      },
      {
        targetName: "RycoWidgets",
        bundleIdentifier: "dev.ryco.app.dev.RycoWidgets",
        entitlements: { "com.apple.security.application-groups": [APP_GROUP] },
      },
    ]);
  });
});

/** The Swift module names of the app's own pods: each podspec under `modules`. */
function localPodModuleNames(): string[] {
  const modules = join(MOBILE_ROOT, "modules");
  const podspecs = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() && entry.name !== "node_modules"
        ? podspecs(join(directory, entry.name))
        : entry.name.endsWith(".podspec")
          ? [join(directory, entry.name)]
          : [],
    );
  return podspecs(modules).flatMap(
    (file) => /s\.name\s*=\s*'([^']+)'/u.exec(readFileSync(file, "utf8"))?.[1] ?? [],
  );
}

describe("the extension target", () => {
  it("names its Swift module apart from every pod the app imports", () => {
    withTemporaryDirectory((directory) => {
      mkdirSync(join(directory, "ios"));
      const project = templateProject(join(directory, "ios"));
      plugin.addWidgetsTarget(project, { bundleIdentifier: BUNDLE_ID });
      const pods = localPodModuleNames();
      expect(pods).toContain("RycoWidgets");
      for (const settings of Object.values(settingsOf(project, `"${plugin.TARGET_NAME}"`))) {
        // Without its own, a target's module is named after its product.
        const moduleName = String(settings.PRODUCT_MODULE_NAME ?? settings.PRODUCT_NAME);
        expect(pods).not.toContain(moduleName.replaceAll('"', ""));
      }
    });
  });

  it("is added once, next to the notification service, and both are embedded once", () => {
    withTemporaryDirectory((directory) => {
      mkdirSync(join(directory, "ios"));
      const project = templateProject(join(directory, "ios"));

      notificationService.addNotificationServiceTarget(project, { bundleIdentifier: BUNDLE_ID });
      plugin.addWidgetsTarget(project, { bundleIdentifier: BUNDLE_ID, appleTeamId: "TEAM123456" });
      // Prebuild runs the plugins on every pass; a second one changes nothing.
      plugin.addWidgetsTarget(project, { bundleIdentifier: BUNDLE_ID });
      notificationService.addNotificationServiceTarget(project, { bundleIdentifier: BUNDLE_ID });

      const objects = project.hash.project.objects;
      const targets = Object.values(project.pbxNativeTargetSection()).filter(
        (target) => typeof target === "object" && target.name === `"${plugin.TARGET_NAME}"`,
      );
      expect(targets).toHaveLength(1);
      const extension = project.pbxTargetByName(`"${plugin.TARGET_NAME}"`)!;
      expect(extension.productType).toBe('"com.apple.product-type.app-extension"');

      const phases = extension.buildPhases as Array<{ value: string; comment: string }>;
      const sources = phases.find((phase) => phase.comment === "Sources")!;
      expect(phaseFiles(project, sources.value, "PBXSourcesBuildPhase").toSorted()).toEqual([
        "AgentActivityAttributes.swift in Sources",
        "AgentActivityContentState.swift in Sources",
        "AgentActivityWidget.swift in Sources",
        "RycoWidgetsBundle.swift in Sources",
        "SubscriptionUsageContent.swift in Sources",
        "SubscriptionUsageWidget.swift in Sources",
        "WidgetGroupStore.swift in Sources",
        "WidgetTimelineStore.swift in Sources",
      ]);

      // One phase embeds both extensions, each once; the `xcode` package would leave two.
      const embeds = extensionEmbedPhases(project);
      expect(embeds).toHaveLength(1);
      expect((embeds[0]!.files as Array<{ comment: string }>).map((file) => file.comment)).toEqual([
        "RycoNotificationService.appex in Copy Files",
        "RycoWidgets.appex in Copy Files",
      ]);
      const app = project.getFirstTarget().firstTarget;
      const dependencies = (app.dependencies as Array<{ value: string }>).map(
        ({ value }) => objects.PBXTargetDependency[value].target_comment,
      );
      expect(dependencies).toEqual(
        expect.arrayContaining(['"RycoNotificationService"', `"${plugin.TARGET_NAME}"`]),
      );

      // Each extension's group holds references of its own: both have an `Info.plist`.
      const groupChildren = (name: string) =>
        Object.values(objects.PBXGroup).find(
          (group) => typeof group === "object" && group.name === name,
        ).children as Array<{ value: string; comment: string }>;
      const widgetFiles = groupChildren(plugin.TARGET_NAME);
      const serviceFiles = groupChildren("RycoNotificationService");
      expect(widgetFiles.map((file) => file.comment)).toContain("Info.plist");
      expect(serviceFiles.map((file) => file.comment)).toContain("Info.plist");
      const serviceRefs = new Set(serviceFiles.map((file) => file.value));
      expect(widgetFiles.filter((file) => serviceRefs.has(file.value))).toEqual([]);

      for (const [name, settings] of Object.entries(
        settingsOf(project, `"${plugin.TARGET_NAME}"`),
      )) {
        expect(settings, name).toMatchObject({
          PRODUCT_BUNDLE_IDENTIFIER: `"${BUNDLE_ID}.RycoWidgets"`,
          CODE_SIGN_ENTITLEMENTS: '"RycoWidgets/RycoWidgets.entitlements"',
          INFOPLIST_FILE: '"RycoWidgets/Info.plist"',
          // The template app targets 16.4; WidgetKit's App Intent configuration needs 17.
          IPHONEOS_DEPLOYMENT_TARGET: "17.0",
          // The widgets pod is the `RycoWidgets` module the app imports.
          PRODUCT_MODULE_NAME: "RycoWidgetsExtension",
          DEVELOPMENT_TEAM: "TEAM123456",
          SWIFT_VERSION: "5.0",
        });
      }

      const written = project.writeSync();
      expect(written).toContain("RycoWidgets.appex");
      expect(written).not.toContain("= undefined;");
      expect(written).not.toMatch(/Info\.plist in |\.entitlements in /u);
    });
  });
});
