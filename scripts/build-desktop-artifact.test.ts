import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ConfigProvider, Effect, Option, Stream } from "effect";

import {
  ANTHROPIC_CLAUDE_AGENT_SDK_NATIVE_PACKAGE_PATHS,
  COMMAND_OUTPUT_TAIL_LENGTH,
  COPILOT_SDK_PACKAGE_JSON_PATH,
  DESKTOP_BUILD_FILES,
  DESKTOP_BUILD_RESOURCES_RELATIVE_DIR,
  EXTERNALIZED_DESKTOP_DEPENDENCY_PATHS,
  LINUX_ICON_SIZES,
  MAC_UNSIGNED_INSTALL_HELPER_NAME,
  MAC_UNSIGNED_README_NAME,
  PRUNED_DESKTOP_DEPENDENCY_PATHS,
  appendOutputTail,
  collectCommandStream,
  createMacUnsignedInstallReadme,
  createMacUnsignedInstallScript,
  createBuildConfig,
  createElectronBuilderInvocation,
  createStagePatchedDependencies,
  formatCommandFailureMessage,
  formatOutputSection,
  pruneExternalizedDesktopDependencies,
  resolveElectronBuilderDebugEnv,
  resolveBuildOptions,
  resolveDesktopBuildIconAssets,
  resolveDesktopProductName,
  resolveDesktopUpdateChannel,
  resolveDesktopWebAssetBrand,
  resolveMacUnsignedInstallAssetPaths,
  resolveMockUpdateServerPort,
  resolveMockUpdateServerUrl,
  stageLinuxIcons,
} from "./build-desktop-artifact.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

interface TurboDryRunTask {
  readonly taskId: string;
  readonly dependencies: ReadonlyArray<string>;
  readonly resolvedTaskDefinition: {
    readonly cache?: boolean;
    readonly dependsOn?: ReadonlyArray<string>;
  };
}

interface TurboDryRun {
  readonly tasks: ReadonlyArray<TurboDryRunTask>;
}

const repoRoot = path.resolve(import.meta.dirname, "..");
const encoder = new TextEncoder();

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function writeFakeImageMagickCommand(binDir: string, commandName: string, logPath: string): void {
  const commandPath = path.join(binDir, commandName);
  writeFileSync(
    commandPath,
    [
      "#!/bin/sh",
      `printf '${commandName}|%s|%s|%s|%s\\n' "$1" "$2" "$3" "$4" >> ${shellSingleQuote(logPath)}`,
      'printf "generated %s\\n" "$3" > "$4"',
      "",
    ].join("\n"),
  );
  chmodSync(commandPath, 0o755);
}

const parseTurboDryRun = (output: string): TurboDryRun => {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");

  assert.ok(start >= 0 && end > start, `Expected Turbo dry-run JSON output, received:\n${output}`);
  return JSON.parse(output.slice(start, end + 1)) as TurboDryRun;
};

const getTask = (dryRun: TurboDryRun, taskId: string): TurboDryRunTask => {
  const task = dryRun.tasks.find((candidate) => candidate.taskId === taskId);
  assert.ok(
    task,
    `Expected Turbo dry-run task ${taskId}; tasks were: ${dryRun.tasks
      .map((candidate) => candidate.taskId)
      .join(", ")}`,
  );
  return task;
};

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it("keeps a bounded tail of command output", () => {
    const oversized = "a".repeat(COMMAND_OUTPUT_TAIL_LENGTH + 5);
    const tail = appendOutputTail("", oversized);

    assert.equal(tail.length, COMMAND_OUTPUT_TAIL_LENGTH);
    assert.equal(tail, oversized.slice(-COMMAND_OUTPUT_TAIL_LENGTH));
    assert.equal(appendOutputTail("old", "new"), "oldnew");
  });

  it("formats labeled command output tails for failures", () => {
    assert.equal(formatOutputSection("stdout", " \n ok \n "), "stdout tail:\nok");
    assert.equal(formatOutputSection("stderr", " \n "), undefined);

    assert.equal(
      formatCommandFailureMessage(
        1,
        {
          label:
            "bun x --no-install electron-builder --projectDir /tmp/ryco-stage/app --win --x64 --publish never",
        },
        { stdout: "stdout detail\n", stderr: "stderr detail\n" },
      ),
      [
        "Command exited with non-zero exit code (1)",
        "",
        "Command: bun x --no-install electron-builder --projectDir /tmp/ryco-stage/app --win --x64 --publish never",
        "",
        "stdout tail:",
        "stdout detail",
        "",
        "stderr tail:",
        "stderr detail",
      ].join("\n"),
    );
    assert.equal(
      formatCommandFailureMessage(2, {}, { stdout: "", stderr: "" }),
      "Command exited with non-zero exit code (2)",
    );
  });

  it.effect("captures command streams and writes through only in verbose mode", () =>
    Effect.gen(function* () {
      let written = "";
      const output = {
        write(chunk: string) {
          written += chunk;
          return true;
        },
      } as NodeJS.WriteStream;

      const nonVerbose = yield* collectCommandStream(
        Stream.make(encoder.encode("first"), encoder.encode("second")),
        output,
        false,
      );
      assert.equal(nonVerbose, "firstsecond");
      assert.equal(written, "");

      const verbose = yield* collectCommandStream(
        Stream.make(encoder.encode("third"), encoder.encode("fourth")),
        output,
        true,
      );
      assert.equal(verbose, "thirdfourth");
      assert.equal(written, "thirdfourth");
    }),
  );

  it("adds electron-builder debug namespaces only for verbose artifact builds", () => {
    assert.equal(resolveElectronBuilderDebugEnv(undefined, false), undefined);
    assert.equal(resolveElectronBuilderDebugEnv("existing", false), "existing");
    assert.equal(
      resolveElectronBuilderDebugEnv(undefined, true),
      "electron-builder,electron-builder:*",
    );
    assert.equal(resolveElectronBuilderDebugEnv("", true), "electron-builder,electron-builder:*");
    assert.equal(
      resolveElectronBuilderDebugEnv("existing", true),
      "existing,electron-builder,electron-builder:*",
    );
  });

  it("runs electron-builder from the desktop workspace against the staged app", () => {
    const desktopWorkspaceDir = path.join(repoRoot, "apps/desktop");
    const stageAppDir = path.join(repoRoot, ".tmp", "ryco-stage", "app");
    const invocation = createElectronBuilderInvocation({
      desktopWorkspaceDir,
      stageAppDir,
      platformFlag: "--win",
      arch: "x64",
    });

    assert.equal(invocation.cwd, desktopWorkspaceDir);
    assert.equal(invocation.command, "bun");
    assert.deepStrictEqual(invocation.args, [
      "x",
      "--no-install",
      "electron-builder",
      "--projectDir",
      stageAppDir,
      "--win",
      "--x64",
      "--publish",
      "never",
    ]);
    assert.equal(
      invocation.label,
      `bun x --no-install electron-builder --projectDir ${stageAppDir} --win --x64 --publish never`,
    );
  });

  it("resolves electron-builder from the desktop workspace without installing it", () => {
    const result = spawnSync("bun", ["x", "--no-install", "electron-builder", "--version"], {
      cwd: path.join(repoRoot, "apps/desktop"),
      encoding: "utf8",
      shell: process.platform === "win32",
    });

    assert.equal(
      result.status,
      0,
      `Expected desktop electron-builder binary to resolve without install.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.equal(result.stdout.trim(), "26.15.3");
  });

  it("builds the web app before bundling it into the desktop server", () => {
    const result = spawnSync("bun", ["run", "build:desktop", "--dry=json"], {
      cwd: repoRoot,
      encoding: "utf8",
      shell: process.platform === "win32",
    });

    assert.equal(
      result.status,
      0,
      `Expected build:desktop dry-run to pass.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );

    const dryRun = parseTurboDryRun(`${result.stdout}\n${result.stderr}`);
    getTask(dryRun, "@ryco/web#build");
    getTask(dryRun, "@ryco/desktop#build");

    const serverTask = getTask(dryRun, "ryco-cli#build");
    assert.ok(serverTask.dependencies.includes("@ryco/web#build"));
    assert.ok(serverTask.resolvedTaskDefinition.dependsOn?.includes("@ryco/web#build"));
    assert.equal(serverTask.resolvedTaskDefinition.cache, false);
  });

  it("resolves the dedicated nightly updater channel from nightly versions", () => {
    assert.equal(resolveDesktopUpdateChannel("0.0.17-nightly.20260413.42"), "nightly");
    assert.equal(resolveDesktopUpdateChannel("0.0.17"), "latest");
  });

  it("switches desktop packaging product names to nightly for nightly builds", () => {
    assert.equal(resolveDesktopProductName("0.0.17"), "Ryco");
    assert.equal(resolveDesktopProductName("0.0.17-nightly.20260413.42"), "Ryco (Nightly)");
  });

  it("switches desktop packaging icons to the nightly artwork for nightly versions", () => {
    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17"), {
      macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
      macIconset: BRAND_ASSET_PATHS.productionMacIconset,
      linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    });

    assert.deepStrictEqual(resolveDesktopBuildIconAssets("0.0.17-nightly.20260413.42"), {
      macIconPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
      macIconset: BRAND_ASSET_PATHS.nightlyMacIconset,
      linuxIconPng: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    });
  });

  it("switches packaged web assets to nightly artwork for nightly versions", () => {
    assert.equal(resolveDesktopWebAssetBrand("0.0.17"), "production");
    assert.equal(resolveDesktopWebAssetBrand("0.0.17-nightly.20260413.42"), "nightly");
  });

  it("carries only staged dependency patch metadata into staged Bun installs", () => {
    assert.deepStrictEqual(
      createStagePatchedDependencies(
        {
          "@expo/metro-config@56.0.13": "patches/@expo%2Fmetro-config@56.0.13.patch",
          "@pierre/diffs@1.1.20": "patches/@pierre%2Fdiffs@1.1.20.patch",
          "alchemy@2.0.0-beta.49": "patches/alchemy@2.0.0-beta.49.patch",
          "effect@4.0.0-beta.106": "patches/effect@4.0.0-beta.106.patch",
        },
        {
          "@pierre/diffs": "1.1.20",
          effect: "4.0.0-beta.106",
        },
      ),
      {
        "@pierre/diffs@1.1.20": "patches/@pierre%2Fdiffs@1.1.20.patch",
        "effect@4.0.0-beta.106": "patches/effect@4.0.0-beta.106.patch",
      },
    );

    assert.equal(
      createStagePatchedDependencies(
        {
          "@expo/metro-config@56.0.13": "patches/@expo%2Fmetro-config@56.0.13.patch",
        },
        { effect: "4.0.0-beta.106" },
      ),
      undefined,
    );
  });

  it.effect("stages standard Linux AppImage icon sizes with ImageMagick", () =>
    Effect.gen(function* () {
      const tempRoot = mkdtempSync(path.join(tmpdir(), "ryco-linux-icons-"));
      const previousPath = process.env.PATH;
      try {
        const stageResourcesDir = path.join(tempRoot, "resources");
        const binDir = path.join(tempRoot, "bin");
        const sourcePng = path.join(tempRoot, "source.png");
        const logPath = path.join(tempRoot, "magick.log");
        mkdirSync(stageResourcesDir, { recursive: true });
        mkdirSync(binDir, { recursive: true });
        writeFileSync(sourcePng, "source icon\n");
        writeFakeImageMagickCommand(binDir, "magick", logPath);

        process.env.PATH = binDir;

        yield* stageLinuxIcons(stageResourcesDir, sourcePng, false);

        assert.equal(
          readFileSync(path.join(stageResourcesDir, "icon.png"), "utf8"),
          "source icon\n",
        );
        assert.deepStrictEqual(LINUX_ICON_SIZES, [16, 22, 24, 32, 48, 64, 128, 256, 512]);
        for (const iconSize of LINUX_ICON_SIZES) {
          assert.equal(
            readFileSync(
              path.join(stageResourcesDir, "icons", `${iconSize}x${iconSize}.png`),
              "utf8",
            ),
            `generated ${iconSize}x${iconSize}\n`,
          );
        }
        assert.deepStrictEqual(
          readFileSync(logPath, "utf8").trim().split("\n"),
          LINUX_ICON_SIZES.map(
            (iconSize) =>
              `magick|${sourcePng}|-resize|${iconSize}x${iconSize}|${path.join(
                stageResourcesDir,
                "icons",
                `${iconSize}x${iconSize}.png`,
              )}`,
          ),
        );
      } finally {
        process.env.PATH = previousPath;
        rmSync(tempRoot, { recursive: true, force: true });
      }
    }),
  );

  it.effect("falls back to convert when magick is unavailable for Linux icons", () =>
    Effect.gen(function* () {
      const tempRoot = mkdtempSync(path.join(tmpdir(), "ryco-linux-icons-convert-"));
      const previousPath = process.env.PATH;
      try {
        const stageResourcesDir = path.join(tempRoot, "resources");
        const binDir = path.join(tempRoot, "bin");
        const sourcePng = path.join(tempRoot, "source.png");
        const logPath = path.join(tempRoot, "convert.log");
        mkdirSync(stageResourcesDir, { recursive: true });
        mkdirSync(binDir, { recursive: true });
        writeFileSync(sourcePng, "source icon\n");
        writeFakeImageMagickCommand(binDir, "convert", logPath);

        process.env.PATH = binDir;

        yield* stageLinuxIcons(stageResourcesDir, sourcePng, false);

        assert.ok(existsSync(path.join(stageResourcesDir, "icons", "512x512.png")));
        assert.deepStrictEqual(
          readFileSync(logPath, "utf8").trim().split("\n"),
          LINUX_ICON_SIZES.map(
            (iconSize) =>
              `convert|${sourcePng}|-resize|${iconSize}x${iconSize}|${path.join(
                stageResourcesDir,
                "icons",
                `${iconSize}x${iconSize}.png`,
              )}`,
          ),
        );
      } finally {
        process.env.PATH = previousPath;
        rmSync(tempRoot, { recursive: true, force: true });
      }
    }),
  );

  it.effect("points Linux electron-builder config at the generated icon directory", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig(
        "linux",
        "AppImage",
        "0.1.1",
        false,
        false,
        undefined,
        undefined,
      );

      assert.deepStrictEqual(config.linux, {
        target: ["AppImage"],
        executableName: "ryco",
        icon: "icons",
        category: "Development",
        desktop: {
          entry: {
            StartupWMClass: "ryco",
          },
        },
      });
    }),
  );

  it.effect("disables Windows signing when unsigned desktop artifacts are requested", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig(
        "win",
        "nsis",
        "0.1.1",
        false,
        false,
        undefined,
        undefined,
      );

      assert.deepStrictEqual(config.win, {
        target: ["nsis"],
        icon: "icon.ico",
        signAndEditExecutable: false,
      });
      assert.equal(config.npmRebuild, false);
    }),
  );

  it.effect("uses electron-builder 26 signtoolOptions for certificate-based Windows signing", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig(
        "win",
        "nsis",
        "0.1.1",
        true,
        false,
        undefined,
        undefined,
      );

      assert.deepStrictEqual(config.win, {
        target: ["nsis"],
        icon: "icon.ico",
        signtoolOptions: {
          signingHashAlgorithms: ["sha256"],
        },
      });
    }),
  );

  it.effect("uses Azure Trusted Signing options without signtoolOptions on Windows", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig(
        "win",
        "nsis",
        "0.1.1",
        true,
        false,
        undefined,
        undefined,
      ).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                AZURE_TRUSTED_SIGNING_PUBLISHER_NAME: "Example Publisher",
                AZURE_TRUSTED_SIGNING_ENDPOINT: "https://example.eus.codesigning.azure.net/",
                AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME: "ExampleProfile",
                AZURE_TRUSTED_SIGNING_ACCOUNT_NAME: "ExampleAccount",
              },
            }),
          ),
        ),
      );

      assert.deepStrictEqual(config.win, {
        target: ["nsis"],
        icon: "icon.ico",
        azureSignOptions: {
          publisherName: "Example Publisher",
          endpoint: "https://example.eus.codesigning.azure.net/",
          certificateProfileName: "ExampleProfile",
          codeSigningAccountName: "ExampleAccount",
          fileDigest: "SHA256",
          timestampDigest: "SHA256",
          timestampRfc3161: "http://timestamp.acs.microsoft.com",
        },
      });
    }),
  );

  it("excludes the bundled GitHub Copilot CLI from desktop artifacts", () => {
    assert.deepStrictEqual(DESKTOP_BUILD_FILES, [
      "**/*",
      "!apps/desktop/resources/ryco-desktop-security-helper",
      "!apps/desktop/prod-resources/ryco-desktop-security-helper",
      "!node_modules/@github/copilot/**",
      "!node_modules/@github/copilot-darwin-arm64/**",
      "!node_modules/@github/copilot-darwin-x64/**",
      "!node_modules/@github/copilot-linux-arm64/**",
      "!node_modules/@github/copilot-linux-x64/**",
      "!node_modules/@github/copilot-win32-arm64/**",
      "!node_modules/@github/copilot-win32-x64/**",
      "!node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/**",
      "!node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/**",
      "!node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/**",
      "!node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64-musl/**",
      "!node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/**",
      "!node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/**",
      "!node_modules/@anthropic-ai/claude-agent-sdk-win32-arm64/**",
      "!node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/**",
    ]);
    assert.deepStrictEqual(EXTERNALIZED_DESKTOP_DEPENDENCY_PATHS, [
      "node_modules/@github/copilot",
      "node_modules/@github/copilot-darwin-arm64",
      "node_modules/@github/copilot-darwin-x64",
      "node_modules/@github/copilot-linux-arm64",
      "node_modules/@github/copilot-linux-x64",
      "node_modules/@github/copilot-win32-arm64",
      "node_modules/@github/copilot-win32-x64",
    ]);
    assert.deepStrictEqual(ANTHROPIC_CLAUDE_AGENT_SDK_NATIVE_PACKAGE_PATHS, [
      "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64",
      "node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64",
      "node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64",
      "node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64-musl",
      "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64",
      "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl",
      "node_modules/@anthropic-ai/claude-agent-sdk-win32-arm64",
      "node_modules/@anthropic-ai/claude-agent-sdk-win32-x64",
    ]);
    assert.deepStrictEqual(PRUNED_DESKTOP_DEPENDENCY_PATHS, [
      ...EXTERNALIZED_DESKTOP_DEPENDENCY_PATHS,
      ...ANTHROPIC_CLAUDE_AGENT_SDK_NATIVE_PACKAGE_PATHS,
    ]);
    assert.equal(COPILOT_SDK_PACKAGE_JSON_PATH, "node_modules/@github/copilot-sdk/package.json");
  });

  it.effect("packages the macOS security helper outside the app archive", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.1.1",
        true,
        false,
        undefined,
        undefined,
      );

      assert.deepStrictEqual(config.extraResources, [
        { from: "apps/desktop/resources/ryco-computer-use-helper", to: "ryco-computer-use-helper" },
        { from: "apps/desktop/resources/browser-extension", to: "browser-extension" },
        { from: "apps/desktop/resources/computer-use-licenses", to: "computer-use-licenses" },
        {
          from: "apps/desktop/resources/ryco-desktop-security-helper",
          to: "ryco-desktop-security-helper",
        },
        {
          from: "apps/server/dist/device-helper",
          to: "device-helper",
        },
      ]);
      assert.deepStrictEqual(config.protocols, [
        { name: "Ryco Hosted Authorization", schemes: ["ryco"] },
      ]);

      const nightly = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.1.1-nightly.20260812.1",
        true,
        false,
        undefined,
        undefined,
      );
      assert.deepStrictEqual(nightly.protocols, [
        { name: "Ryco Hosted Authorization", schemes: ["ryco-preview"] },
      ]);
    }),
  );

  it.effect("prunes bundled provider CLI payloads without removing JS SDKs or sharp", () =>
    Effect.gen(function* () {
      const tempRoot = mkdtempSync(path.join(tmpdir(), "ryco-desktop-prune-"));
      try {
        const stageAppDir = path.join(tempRoot, "app");
        const copilotSdkPackageJson = path.join(stageAppDir, COPILOT_SDK_PACKAGE_JSON_PATH);
        const anthropicNativeDir = path.join(
          stageAppDir,
          "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64",
        );
        const anthropicSdkDir = path.join(
          stageAppDir,
          "node_modules/@anthropic-ai/claude-agent-sdk",
        );
        const anthropicPeerSdkDir = path.join(stageAppDir, "node_modules/@anthropic-ai/sdk");
        const sharpDir = path.join(stageAppDir, "node_modules/sharp");

        for (const dir of [
          path.dirname(copilotSdkPackageJson),
          path.join(stageAppDir, "node_modules/@github/copilot"),
          anthropicNativeDir,
          anthropicSdkDir,
          anthropicPeerSdkDir,
          sharpDir,
        ]) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(
          copilotSdkPackageJson,
          [
            "{",
            '  "dependencies": {',
            '    "@github/copilot": "1.0.0",',
            '    "keep": "1.0.0"',
            "  }",
            "}",
            "",
          ].join("\n"),
        );
        writeFileSync(path.join(anthropicNativeDir, "claude"), "native claude binary");
        writeFileSync(path.join(anthropicSdkDir, "sdk.mjs"), "export {}");
        writeFileSync(path.join(anthropicPeerSdkDir, "index.mjs"), "export {}");
        writeFileSync(path.join(sharpDir, "index.js"), "module.exports = {}");

        yield* pruneExternalizedDesktopDependencies(stageAppDir);

        assert.equal(existsSync(path.join(stageAppDir, "node_modules/@github/copilot")), false);
        assert.equal(existsSync(anthropicNativeDir), false);
        assert.equal(existsSync(anthropicSdkDir), true);
        assert.equal(existsSync(anthropicPeerSdkDir), true);
        assert.equal(existsSync(sharpDir), true);
        const prunedCopilotSdkPackageJson = readFileSync(copilotSdkPackageJson, "utf8");
        assert.equal(prunedCopilotSdkPackageJson.includes('"@github/copilot"'), false);
        assert.equal(prunedCopilotSdkPackageJson.includes('"keep": "1.0.0"'), true);
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    }),
  );

  it("generates an unsigned macOS install helper for stable and nightly bundle names", () => {
    assert.equal(MAC_UNSIGNED_INSTALL_HELPER_NAME, "Install Ryco.command");
    assert.equal(MAC_UNSIGNED_README_NAME, "README-macOS.txt");

    const stableScript = createMacUnsignedInstallScript("Ryco");
    assert.ok(stableScript.includes("APP_NAME='Ryco.app'"));
    assert.ok(stableScript.includes("xattr -dr com.apple.quarantine"));
    assert.ok(stableScript.includes('TARGET_APP="/Applications/$APP_NAME"'));

    const nightlyScript = createMacUnsignedInstallScript("Ryco (Nightly)");
    assert.ok(nightlyScript.includes("APP_NAME='Ryco (Nightly).app'"));
    assert.ok(nightlyScript.includes('ditto "$SOURCE_APP" "$TARGET_APP"'));
  });

  it("explains the unsigned macOS install fallback without promising notarization", () => {
    const readme = createMacUnsignedInstallReadme("Ryco");
    assert.ok(readme.includes("unsigned and not notarized"));
    assert.ok(readme.includes("Apple requires a paid Developer ID account"));
    assert.ok(readme.includes('xattr -dr com.apple.quarantine "/Applications/Ryco.app"'));
    assert.ok(readme.includes("https://github.com/sak0a/ryco/releases"));
  });

  it("resolves unsigned macOS DMG assets to absolute staged files", () => {
    const stageResourcesDir = path.join(
      repoRoot,
      ".tmp",
      "ryco-stage",
      "app",
      DESKTOP_BUILD_RESOURCES_RELATIVE_DIR,
    );
    const resolved = resolveMacUnsignedInstallAssetPaths(stageResourcesDir, path);

    assert.equal(
      resolved.installHelperFilePath,
      path.join(stageResourcesDir, MAC_UNSIGNED_INSTALL_HELPER_NAME),
    );
    assert.equal(resolved.installHelperDmgPath, resolved.installHelperFilePath);
    assert.equal(resolved.readmeFilePath, path.join(stageResourcesDir, MAC_UNSIGNED_README_NAME));
    assert.equal(resolved.readmeDmgPath, resolved.readmeFilePath);
  });

  it.effect("uses electron-builder's current DMG window schema", () =>
    Effect.gen(function* () {
      const installHelperPath = "/tmp/ryco-stage/app/apps/desktop/resources/Install Ryco.command";
      const readmePath = "/tmp/ryco-stage/app/apps/desktop/resources/README-macOS.txt";
      const config = yield* createBuildConfig("mac", "dmg", "0.1.1", false, false, undefined, {
        installHelperFilePath: installHelperPath,
        readmeFilePath: readmePath,
        installHelperDmgPath: installHelperPath,
        readmeDmgPath: readmePath,
      });

      assert.deepStrictEqual(config.dmg, {
        window: {
          width: 560,
          height: 430,
        },
        contents: [
          {
            x: 140,
            y: 155,
            type: "file",
          },
          {
            x: 420,
            y: 155,
            type: "link",
            path: "/Applications",
          },
          {
            x: 140,
            y: 320,
            type: "file",
            path: installHelperPath,
            name: MAC_UNSIGNED_INSTALL_HELPER_NAME,
          },
          {
            x: 420,
            y: 320,
            type: "file",
            path: readmePath,
            name: MAC_UNSIGNED_README_NAME,
          },
        ],
        iconSize: 80,
        iconTextSize: 12,
      });
    }),
  );

  it("falls back to the default mock update port when the configured port is blank", () => {
    assert.equal(resolveMockUpdateServerUrl(undefined), "http://localhost:3000");
    assert.equal(resolveMockUpdateServerUrl(4123), "http://localhost:4123");
  });

  it.effect("normalizes mock update server ports from env-style strings", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveMockUpdateServerPort(undefined), undefined);
      assert.equal(yield* resolveMockUpdateServerPort(""), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("   "), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("4123"), 4123);
    }),
  );

  it.effect("rejects non-numeric or out-of-range mock update ports", () =>
    Effect.gen(function* () {
      const invalidPorts = ["abc", "12.5", "0", "65536"];
      for (const port of invalidPorts) {
        const exit = yield* Effect.exit(resolveMockUpdateServerPort(port));
        assert.equal(exit._tag, "Failure");
      }
    }),
  );

  it.effect("preserves explicit false boolean flags over true env defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.some("mac"),
        target: Option.none(),
        arch: Option.some("arm64"),
        buildVersion: Option.none(),
        outputDir: Option.some("release-test"),
        skipBuild: Option.some(false),
        keepStage: Option.some(false),
        signed: Option.some(false),
        verbose: Option.some(false),
        mockUpdates: Option.some(false),
        mockUpdateServerPort: Option.none(),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                RYCO_DESKTOP_SKIP_BUILD: "true",
                RYCO_DESKTOP_KEEP_STAGE: "true",
                RYCO_DESKTOP_SIGNED: "true",
                RYCO_DESKTOP_VERBOSE: "true",
                RYCO_DESKTOP_MOCK_UPDATES: "true",
              },
            }),
          ),
        ),
      );

      assert.equal(resolved.skipBuild, false);
      assert.equal(resolved.keepStage, false);
      assert.equal(resolved.signed, false);
      assert.equal(resolved.verbose, false);
      assert.equal(resolved.mockUpdates, false);
    }),
  );
});
