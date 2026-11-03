import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  IOSConfig,
  phaseFiles,
  settingsOf,
  templateProject,
  withTemporaryDirectory,
  type XcodeProject,
} from "./lib/xcodeTestProject";

const require = createRequire(import.meta.url);
const plugin = require("./withIosNotificationServiceExtension.cjs") as ((
  config: Record<string, unknown>,
) => Record<string, any>) & {
  readonly TARGET_NAME: string;
  readonly addPushKeychainGroup: (
    entitlements: Readonly<Record<string, unknown>>,
    bundleIdentifier: string,
  ) => Record<string, unknown>;
  readonly addNotificationServiceTarget: (
    project: XcodeProject,
    options: { readonly bundleIdentifier: string; readonly appleTeamId?: string },
  ) => XcodeProject;
  readonly notificationServiceInfoPlist: (
    config: Record<string, unknown>,
  ) => Record<string, unknown>;
  readonly notificationServiceEntitlements: (bundleIdentifier: string) => Record<string, unknown>;
  readonly writeNotificationServiceFiles: (
    platformProjectRoot: string,
    config: Record<string, unknown>,
  ) => void;
};

const BUNDLE_ID = "dev.ryco.app.dev";
const CONFIG = {
  name: "Ryco Dev",
  version: "0.1.0",
  scheme: "ryco-dev",
  ios: { bundleIdentifier: BUNDLE_ID, buildNumber: "7" },
};

describe("the push keychain group", () => {
  it("keeps the app's own group first, so its other secrets stay out of the extension's reach", () => {
    expect(plugin.addPushKeychainGroup({ "aps-environment": "development" }, BUNDLE_ID)).toEqual({
      "aps-environment": "development",
      "keychain-access-groups": [
        "$(AppIdentifierPrefix)dev.ryco.app.dev",
        "$(AppIdentifierPrefix)dev.ryco.app.dev.push",
      ],
    });
    const existing = { "keychain-access-groups": ["$(AppIdentifierPrefix)shared"] };
    expect(plugin.addPushKeychainGroup(existing, BUNDLE_ID)["keychain-access-groups"]).toEqual([
      "$(AppIdentifierPrefix)shared",
      "$(AppIdentifierPrefix)dev.ryco.app.dev.push",
    ]);
    expect(existing["keychain-access-groups"]).toHaveLength(1);
    const twice = plugin.addPushKeychainGroup(
      plugin.addPushKeychainGroup({}, BUNDLE_ID),
      BUNDLE_ID,
    );
    expect(twice["keychain-access-groups"]).toHaveLength(2);
  });

  it("is the only group the extension gets", () => {
    expect(plugin.notificationServiceEntitlements(BUNDLE_ID)).toEqual({
      "keychain-access-groups": ["$(AppIdentifierPrefix)dev.ryco.app.dev.push"],
    });
  });
});

describe("the extension's Info.plist", () => {
  it("declares a notification service with the app's versions, group and scheme", () => {
    expect(plugin.notificationServiceInfoPlist(CONFIG)).toMatchObject({
      CFBundleShortVersionString: "0.1.0",
      CFBundleVersion: "7",
      NSExtension: {
        NSExtensionPointIdentifier: "com.apple.usernotifications.service",
        NSExtensionPrincipalClass: "$(PRODUCT_MODULE_NAME).NotificationService",
      },
      RycoPushKeychainGroup: "$(AppIdentifierPrefix)dev.ryco.app.dev.push",
      RycoAppScheme: "ryco-dev",
    });
  });

  it("takes its versions from where Expo takes the app's", () => {
    for (const config of [
      CONFIG,
      { ...CONFIG, ios: { ...CONFIG.ios, version: "0.2.0" } },
      { ...CONFIG, ios: { bundleIdentifier: BUNDLE_ID } },
      { name: "Ryco Dev", ios: { bundleIdentifier: BUNDLE_ID } },
    ]) {
      expect(plugin.notificationServiceInfoPlist(config)).toMatchObject({
        CFBundleShortVersionString: IOSConfig.Version.getVersion(config),
        CFBundleVersion: IOSConfig.Version.getBuildNumber(config),
      });
    }
    expect(
      plugin.notificationServiceInfoPlist({ ...CONFIG, ios: { ...CONFIG.ios, version: "0.2.0" } }),
    ).toMatchObject({ CFBundleShortVersionString: "0.2.0" });
  });

  it("writes the extension's sources next to its plist and entitlements", () => {
    withTemporaryDirectory((directory) => {
      plugin.writeNotificationServiceFiles(directory, CONFIG);
      const extension = join(directory, plugin.TARGET_NAME);
      for (const file of [
        "NotificationService.swift",
        "PushAlertOpener.swift",
        "PushSealOpener.swift",
        "PushKeyStore.swift",
        "Info.plist",
        "RycoNotificationService.entitlements",
      ]) {
        expect(existsSync(join(extension, file)), file).toBe(true);
      }
      expect(readFileSync(join(extension, "Info.plist"), "utf8")).toContain(
        "com.apple.usernotifications.service",
      );
    });
  });
});

describe("EAS Build", () => {
  it("names the extension, so EAS signs it and gives it the app's build number", () => {
    const configured = plugin({
      ...CONFIG,
      extra: { eas: { projectId: "project" }, appVariant: "x" },
    });
    expect(configured.extra).toMatchObject({ eas: { projectId: "project" }, appVariant: "x" });
    expect(configured.extra.eas.build.experimental.ios.appExtensions).toEqual([
      {
        targetName: "RycoNotificationService",
        bundleIdentifier: "dev.ryco.app.dev.RycoNotificationService",
        entitlements: {
          "keychain-access-groups": ["$(AppIdentifierPrefix)dev.ryco.app.dev.push"],
        },
      },
    ]);

    // Config is evaluated more than once; another extension stays, this one is listed once.
    const other = { targetName: "Widget", bundleIdentifier: `${BUNDLE_ID}.Widget` };
    const twice = plugin(
      plugin({
        ...CONFIG,
        extra: { eas: { build: { experimental: { ios: { appExtensions: [other] } } } } },
      }),
    );
    expect(
      twice.extra.eas.build.experimental.ios.appExtensions.map(
        (extension: { readonly targetName: string }) => extension.targetName,
      ),
    ).toEqual(["Widget", "RycoNotificationService"]);
  });
});

describe("the extension target", () => {
  it("is added to Expo's template project, embedded in the app and built before it", () => {
    withTemporaryDirectory((directory) => {
      mkdirSync(join(directory, "ios"));
      const project = templateProject(join(directory, "ios"));
      const app = project.getFirstTarget();
      const appSettings = settingsOf(project, app.firstTarget.name);

      plugin.addNotificationServiceTarget(project, {
        bundleIdentifier: BUNDLE_ID,
        appleTeamId: "TEAM123456",
      });
      // Prebuild runs the plugin on every pass; a second one changes nothing.
      plugin.addNotificationServiceTarget(project, { bundleIdentifier: BUNDLE_ID });

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
        "NotificationService.swift in Sources",
        "PushAlertOpener.swift in Sources",
        "PushKeyStore.swift in Sources",
        "PushSealOpener.swift in Sources",
      ]);

      const embed = (app.firstTarget.buildPhases as Array<{ value: string }>)
        .map((phase) => objects.PBXCopyFilesBuildPhase?.[phase.value])
        .find((phase) => phase !== undefined);
      if (embed === undefined) throw new Error("The app embeds no extension.");
      expect(embed.dstSubfolderSpec).toBe(13);
      expect((embed.files as Array<{ comment: string }>).map((file) => file.comment)).toEqual([
        "RycoNotificationService.appex in Copy Files",
      ]);
      const dependencies = app.firstTarget.dependencies as Array<{ value: string }>;
      expect(
        dependencies.map(({ value }) => objects.PBXTargetDependency[value].target_comment),
      ).toContain(`"${plugin.TARGET_NAME}"`);

      for (const [name, settings] of Object.entries(
        settingsOf(project, `"${plugin.TARGET_NAME}"`),
      )) {
        expect(settings, name).toMatchObject({
          PRODUCT_BUNDLE_IDENTIFIER: `"${BUNDLE_ID}.RycoNotificationService"`,
          CODE_SIGN_ENTITLEMENTS: '"RycoNotificationService/RycoNotificationService.entitlements"',
          INFOPLIST_FILE: '"RycoNotificationService/Info.plist"',
          IPHONEOS_DEPLOYMENT_TARGET: appSettings.Debug?.IPHONEOS_DEPLOYMENT_TARGET,
          DEVELOPMENT_TEAM: "TEAM123456",
          SWIFT_VERSION: "5.0",
        });
      }

      // Only the sources and the product are built; nothing is written as `undefined`.
      const written = project.writeSync();
      expect(written).toContain("RycoNotificationService.appex");
      expect(written).not.toContain("= undefined;");
      expect(written).not.toMatch(/Info\.plist in |\.entitlements in /u);
    });
  });
});
