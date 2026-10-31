import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What the config plugin tests read of the `xcode` package's project. */
export interface XcodeProject {
  readonly hash: { readonly project: { readonly objects: Record<string, Record<string, any>> } };
  readonly pbxTargetByName: (name: string) => Record<string, any> | null;
  readonly getFirstTarget: () => {
    readonly uuid: string;
    readonly firstTarget: Record<string, any>;
  };
  readonly pbxNativeTargetSection: () => Record<string, any>;
  readonly writeSync: () => string;
}

const require = createRequire(import.meta.url);

export const { IOSConfig } = require("expo/config-plugins") as {
  readonly IOSConfig: {
    readonly XcodeUtils: { getPbxproj: (projectRoot: string) => XcodeProject };
    readonly Version: {
      readonly getVersion: (config: Record<string, unknown>) => string;
      readonly getBuildNumber: (config: Record<string, unknown>) => string;
    };
  };
};

/** Expo's own prebuild template project, as `expo prebuild` starts from it. */
export function templateProject(directory: string): XcodeProject {
  const template = require.resolve("expo/template.tgz");
  execFileSync("tar", [
    "-xzf",
    template,
    "-C",
    directory,
    "--strip-components=1",
    "package/ios/HelloWorld.xcodeproj/project.pbxproj",
  ]);
  return IOSConfig.XcodeUtils.getPbxproj(directory);
}

export function withTemporaryDirectory<T>(use: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "ryco-ios-plugin-"));
  try {
    return use(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** A target's build settings by configuration name (Debug, Release). */
export function settingsOf(
  project: XcodeProject,
  name: string,
): Record<string, Record<string, unknown>> {
  const objects = project.hash.project.objects;
  const target = project.pbxTargetByName(name);
  const list = objects.XCConfigurationList[target?.buildConfigurationList];
  return Object.fromEntries(
    (list.buildConfigurations as Array<{ value: string }>).map(({ value }) => [
      objects.XCBuildConfiguration[value].name,
      objects.XCBuildConfiguration[value].buildSettings,
    ]),
  );
}

/** The files of one build phase, by their comments ("X.swift in Sources"). */
export function phaseFiles(project: XcodeProject, phaseId: string, isa: string): string[] {
  const objects = project.hash.project.objects;
  return (objects[isa][phaseId].files as Array<{ comment: string }>).map((file) =>
    file.comment.replaceAll('"', ""),
  );
}

/** The app target's copy phases that embed app extensions (into PlugIns). */
export function extensionEmbedPhases(project: XcodeProject): Array<Record<string, any>> {
  const objects = project.hash.project.objects;
  return (project.getFirstTarget().firstTarget.buildPhases as Array<{ value: string }>)
    .map((phase) => objects.PBXCopyFilesBuildPhase?.[phase.value])
    .filter((phase) => phase !== undefined && phase.dstSubfolderSpec === 13);
}
