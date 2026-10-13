import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { assertSuccess } from "@effect/vitest/utils";
import { FileSystem, Path, Effect } from "effect";

import {
  isCommandAvailable,
  launchDetached,
  resolveAvailableEditors,
  resolveEditorLaunch,
} from "./open.ts";

it.layer(NodeServices.layer)("resolveEditorLaunch", (it) => {
  it.effect("returns commands for command-based editors", () =>
    Effect.gen(function* () {
      const antigravityLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "antigravity" },
        "darwin",
        { PATH: "" },
      );
      assert.deepEqual(antigravityLaunch, {
        command: "agy",
        args: ["/tmp/workspace"],
      });

      const cursorLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "cursor" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(cursorLaunch, {
        command: "cursor",
        args: ["/tmp/workspace"],
      });

      const traeLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "trae" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(traeLaunch, {
        command: "trae",
        args: ["/tmp/workspace"],
      });

      const kiroLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "kiro" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(kiroLaunch, {
        command: "kiro",
        args: ["ide", "/tmp/workspace"],
      });

      const vscodeLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "vscode" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(vscodeLaunch, {
        command: "code",
        args: ["/tmp/workspace"],
      });

      const vscodeInsidersLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "vscode-insiders" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(vscodeInsidersLaunch, {
        command: "code-insiders",
        args: ["/tmp/workspace"],
      });

      const vscodiumLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "vscodium" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(vscodiumLaunch, {
        command: "codium",
        args: ["/tmp/workspace"],
      });

      for (const [editor, command] of [
        ["windsurf", "windsurf"],
        ["positron", "positron"],
        ["sublime-text", "subl"],
        ["nova", "nova"],
        ["xcode", "xed"],
        ["android-studio", "studio"],
      ] as const) {
        const launch = yield* resolveEditorLaunch(
          { cwd: "/tmp/workspace", editor },
          "darwin",
          { PATH: "" },
          { darwinAppRoots: [] },
        );
        assert.deepEqual(launch, { command, args: ["/tmp/workspace"] });
      }

      const zedLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "zed" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(zedLaunch, {
        command: "zed",
        args: ["/tmp/workspace"],
      });

      const ideaLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "idea" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(ideaLaunch, {
        command: "idea",
        args: ["/tmp/workspace"],
      });

      const aquaLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "aqua" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(aquaLaunch, {
        command: "aqua",
        args: ["/tmp/workspace"],
      });

      const clionLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "clion" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(clionLaunch, {
        command: "clion",
        args: ["/tmp/workspace"],
      });

      const datagripLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "datagrip" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(datagripLaunch, {
        command: "datagrip",
        args: ["/tmp/workspace"],
      });

      const dataspellLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "dataspell" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(dataspellLaunch, {
        command: "dataspell",
        args: ["/tmp/workspace"],
      });

      const golandLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "goland" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(golandLaunch, {
        command: "goland",
        args: ["/tmp/workspace"],
      });

      const phpstormLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "phpstorm" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(phpstormLaunch, {
        command: "phpstorm",
        args: ["/tmp/workspace"],
      });

      const pycharmLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "pycharm" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(pycharmLaunch, {
        command: "pycharm",
        args: ["/tmp/workspace"],
      });

      const riderLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "rider" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(riderLaunch, {
        command: "rider",
        args: ["/tmp/workspace"],
      });

      const rubymineLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "rubymine" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(rubymineLaunch, {
        command: "rubymine",
        args: ["/tmp/workspace"],
      });

      const rustroverLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "rustrover" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(rustroverLaunch, {
        command: "rustrover",
        args: ["/tmp/workspace"],
      });

      const webstormLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "webstorm" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(webstormLaunch, {
        command: "webstorm",
        args: ["/tmp/workspace"],
      });
    }),
  );

  it.effect("applies launch-style-specific navigation arguments", () =>
    Effect.gen(function* () {
      const lineOnly = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/AGENTS.md:48", editor: "cursor" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(lineOnly, {
        command: "cursor",
        args: ["--goto", "/tmp/workspace/AGENTS.md:48"],
      });

      const lineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "cursor" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(lineAndColumn, {
        command: "cursor",
        args: ["--goto", "/tmp/workspace/src/open.ts:71:5"],
      });

      const traeLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "trae" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(traeLineAndColumn, {
        command: "trae",
        args: ["--goto", "/tmp/workspace/src/open.ts:71:5"],
      });

      const kiroLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "kiro" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(kiroLineAndColumn, {
        command: "kiro",
        args: ["ide", "--goto", "/tmp/workspace/src/open.ts:71:5"],
      });

      const vscodeLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "vscode" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(vscodeLineAndColumn, {
        command: "code",
        args: ["--goto", "/tmp/workspace/src/open.ts:71:5"],
      });

      const vscodeInsidersLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "vscode-insiders" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(vscodeInsidersLineAndColumn, {
        command: "code-insiders",
        args: ["--goto", "/tmp/workspace/src/open.ts:71:5"],
      });

      const vscodiumLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "vscodium" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(vscodiumLineAndColumn, {
        command: "codium",
        args: ["--goto", "/tmp/workspace/src/open.ts:71:5"],
      });

      const zedLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "zed" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(zedLineAndColumn, {
        command: "zed",
        args: ["/tmp/workspace/src/open.ts:71:5"],
      });

      const zedLineOnly = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/AGENTS.md:48", editor: "zed" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(zedLineOnly, {
        command: "zed",
        args: ["/tmp/workspace/AGENTS.md:48"],
      });

      const ideaLineOnly = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/AGENTS.md:48", editor: "idea" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(ideaLineOnly, {
        command: "idea",
        args: ["--line", "48", "/tmp/workspace/AGENTS.md"],
      });

      const ideaLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "idea" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(ideaLineAndColumn, {
        command: "idea",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/open.ts"],
      });

      const androidStudioLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "android-studio" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(androidStudioLineAndColumn, {
        command: "studio",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/open.ts"],
      });

      const xcodeLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "xcode" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(xcodeLineAndColumn, {
        command: "xed",
        args: ["--line", "71", "/tmp/workspace/src/open.ts"],
      });

      const novaLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "nova" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(novaLineAndColumn, {
        command: "nova",
        args: ["/tmp/workspace/src/open.ts", "--line", "71:5"],
      });

      const aquaLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "aqua" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(aquaLineAndColumn, {
        command: "aqua",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/open.ts"],
      });

      const clionLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "clion" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(clionLineAndColumn, {
        command: "clion",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/open.ts"],
      });

      const datagripLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "datagrip" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(datagripLineAndColumn, {
        command: "datagrip",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/open.ts"],
      });

      const dataspellLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "dataspell" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(dataspellLineAndColumn, {
        command: "dataspell",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/open.ts"],
      });

      const golandLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "goland" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(golandLineAndColumn, {
        command: "goland",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/open.ts"],
      });

      const phpstormLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "phpstorm" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(phpstormLineAndColumn, {
        command: "phpstorm",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/open.ts"],
      });

      const pycharmLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "pycharm" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(pycharmLineAndColumn, {
        command: "pycharm",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/open.ts"],
      });

      const riderLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "rider" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(riderLineAndColumn, {
        command: "rider",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/open.ts"],
      });

      const rubymineLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "rubymine" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(rubymineLineAndColumn, {
        command: "rubymine",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/open.ts"],
      });

      const rustroverLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/open.ts:71:5", editor: "rustrover" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(rustroverLineAndColumn, {
        command: "rustrover",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/open.ts"],
      });

      const webstormLineOnly = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/AGENTS.md:48", editor: "webstorm" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [] },
      );
      assert.deepEqual(webstormLineOnly, {
        command: "webstorm",
        args: ["--line", "48", "/tmp/workspace/AGENTS.md"],
      });
    }),
  );

  it.effect("falls back to zeditor when zed is not installed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-open-test-" });
      yield* fs.writeFileString(path.join(dir, "zeditor"), "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(path.join(dir, "zeditor"), 0o755);

      const result = yield* resolveEditorLaunch({ cwd: "/tmp/workspace", editor: "zed" }, "linux", {
        PATH: dir,
      });

      assert.deepEqual(result, {
        command: "zeditor",
        args: ["/tmp/workspace"],
      });
    }),
  );

  it.effect("resolves platform-native terminal working directories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const macBin = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-terminal-mac-" });
      const macTerminal = path.join(macBin, "Terminal");
      yield* fs.writeFileString(path.join(macBin, "open"), "#!/bin/sh\nexit 0\n");
      yield* fs.writeFileString(macTerminal, "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(path.join(macBin, "open"), 0o755);
      yield* fs.chmod(macTerminal, 0o755);
      const macLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "terminal" },
        "darwin",
        { PATH: macBin },
        { darwinTerminalAppPaths: [macTerminal] },
      );
      assert.deepEqual(macLaunch, {
        command: "open",
        args: ["-a", "Terminal", "/tmp/workspace"],
      });

      const windowsBin = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-terminal-win-" });
      yield* fs.writeFileString(path.join(windowsBin, "wt.CMD"), "@echo off\r\n");
      const windowsLaunch = yield* resolveEditorLaunch(
        { cwd: "C:\\workspace", editor: "terminal" },
        "win32",
        { PATH: windowsBin, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      );
      assert.deepEqual(windowsLaunch, {
        command: "wt",
        args: ["-d", "C:\\workspace"],
      });

      for (const [command, args] of [
        ["gnome-terminal", ["--working-directory=/tmp/workspace"]],
        ["konsole", ["--workdir", "/tmp/workspace"]],
        ["xfce4-terminal", ["--working-directory=/tmp/workspace"]],
        ["kitty", ["--directory", "/tmp/workspace"]],
        ["wezterm", ["start", "--cwd", "/tmp/workspace"]],
        ["alacritty", ["--working-directory", "/tmp/workspace"]],
        ["ghostty", ["--working-directory=/tmp/workspace"]],
      ] as const) {
        const linuxBin = yield* fs.makeTempDirectoryScoped({
          prefix: `ryco-terminal-${command}-`,
        });
        yield* fs.writeFileString(path.join(linuxBin, command), "#!/bin/sh\nexit 0\n");
        yield* fs.chmod(path.join(linuxBin, command), 0o755);
        const linuxLaunch = yield* resolveEditorLaunch(
          { cwd: "/tmp/workspace", editor: "terminal" },
          "linux",
          { PATH: linuxBin },
        );
        assert.deepEqual(linuxLaunch, { command, args });
      }
    }),
  );

  it.effect("falls back to the primary command when no alias is installed", () =>
    Effect.gen(function* () {
      const result = yield* resolveEditorLaunch({ cwd: "/tmp/workspace", editor: "zed" }, "linux", {
        PATH: "",
      });
      assert.deepEqual(result, {
        command: "zed",
        args: ["/tmp/workspace"],
      });
    }),
  );

  it.effect("maps file-manager editor to OS open commands", () =>
    Effect.gen(function* () {
      const launch1 = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "file-manager" },
        "darwin",
        { PATH: "" },
      );
      assert.deepEqual(launch1, {
        command: "open",
        args: ["/tmp/workspace"],
      });

      const launch2 = yield* resolveEditorLaunch(
        { cwd: "C:\\workspace", editor: "file-manager" },
        "win32",
        { PATH: "" },
      );
      assert.deepEqual(launch2, {
        command: "explorer",
        args: ["C:\\workspace"],
      });

      const launch3 = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "file-manager" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(launch3, {
        command: "xdg-open",
        args: ["/tmp/workspace"],
      });
    }),
  );
});

it.layer(NodeServices.layer)("launchDetached", (it) => {
  it.effect("resolves when command can be spawned", () =>
    Effect.gen(function* () {
      const result = yield* launchDetached({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      }).pipe(Effect.result);
      assertSuccess(result, undefined);
    }),
  );

  it.effect("rejects when command does not exist", () =>
    Effect.gen(function* () {
      const result = yield* launchDetached({
        command: `ryco-no-such-command-${Date.now()}`,
        args: [],
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }),
  );
});

it.layer(NodeServices.layer)("isCommandAvailable", (it) => {
  it.effect("resolves win32 commands with PATHEXT", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-open-test-" });
      yield* fs.writeFileString(path.join(dir, "code.CMD"), "@echo off\r\n");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("code", { platform: "win32", env }), true);
    }),
  );

  it("returns false when a command is not on PATH", () => {
    const env = {
      PATH: "",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    } satisfies NodeJS.ProcessEnv;
    assert.equal(isCommandAvailable("definitely-not-installed", { platform: "win32", env }), false);
  });

  it.effect("does not treat bare files without executable extension as available on win32", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-open-test-" });
      yield* fs.writeFileString(path.join(dir, "npm"), "echo nope\r\n");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("npm", { platform: "win32", env }), false);
    }),
  );

  it.effect("appends PATHEXT for commands with non-executable extensions on win32", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-open-test-" });
      yield* fs.writeFileString(path.join(dir, "my.tool.CMD"), "@echo off\r\n");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("my.tool", { platform: "win32", env }), true);
    }),
  );

  it.effect("uses platform-specific PATH delimiter for platform overrides", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const firstDir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-open-test-" });
      const secondDir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-open-test-" });
      yield* fs.writeFileString(path.join(firstDir, "code.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(secondDir, "code.CMD"), "MZ");
      const env = {
        PATH: `${firstDir};${secondDir}`,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("code", { platform: "win32", env }), true);
    }),
  );
});

it.layer(NodeServices.layer)("resolveAvailableEditors", (it) => {
  it.effect("reuses the scan of the server's own environment until PATH changes", () =>
    Effect.sync(() => {
      const originalPath = process.env.PATH;
      try {
        const first = resolveAvailableEditors();
        assert.strictEqual(resolveAvailableEditors(), first);
        process.env.PATH = `${originalPath ?? ""}${NodePath.delimiter}/ryco-test-editors`;
        assert.notStrictEqual(resolveAvailableEditors(), first);
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    }),
  );

  it.effect("returns installed editors for command launches", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-editors-" });

      yield* fs.writeFileString(path.join(dir, "trae.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "windsurf.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "kiro.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "code-insiders.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "codium.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "positron.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "subl.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "studio.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "aqua.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "clion.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "datagrip.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "dataspell.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "goland.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "phpstorm.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "pycharm.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "rider.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "rubymine.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "rustrover.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "webstorm.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "wt.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "explorer.CMD"), "MZ");
      const editors = resolveAvailableEditors("win32", {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      });
      assert.deepEqual(editors, [
        "windsurf",
        "trae",
        "kiro",
        "vscode-insiders",
        "vscodium",
        "positron",
        "sublime-text",
        "android-studio",
        "aqua",
        "clion",
        "datagrip",
        "dataspell",
        "goland",
        "phpstorm",
        "pycharm",
        "rider",
        "rubymine",
        "rustrover",
        "webstorm",
        "terminal",
        "file-manager",
      ]);
    }),
  );

  it.effect("includes zed when only the zeditor command is installed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-editors-" });

      yield* fs.writeFileString(path.join(dir, "zeditor"), "#!/bin/sh\nexit 0\n");
      yield* fs.writeFileString(path.join(dir, "xdg-open"), "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(path.join(dir, "zeditor"), 0o755);
      yield* fs.chmod(path.join(dir, "xdg-open"), 0o755);

      const editors = resolveAvailableEditors("linux", {
        PATH: dir,
      });
      assert.deepEqual(editors, ["zed", "file-manager"]);
    }),
  );

  it("omits file-manager when the platform opener is unavailable", () => {
    const editors = resolveAvailableEditors("linux", {
      PATH: "",
    });
    assert.deepEqual(editors, []);
  });

  it.effect("detects Cursor via the macOS app bundle CLI when not on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const appRoot = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-darwin-apps-" });
      const bundleDir = path.join(appRoot, "Cursor.app/Contents/Resources/app/bin");
      yield* fs.makeDirectory(bundleDir, { recursive: true });
      yield* fs.writeFileString(path.join(bundleDir, "cursor"), "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(path.join(bundleDir, "cursor"), 0o755);

      const opener = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-darwin-bin-" });
      yield* fs.writeFileString(path.join(opener, "open"), "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(path.join(opener, "open"), 0o755);

      const editors = resolveAvailableEditors(
        "darwin",
        { PATH: opener },
        { darwinAppRoots: [appRoot] },
      );
      assert.include(editors, "cursor");
    }),
  );

  it("does not detect Cursor when no app bundle root contains it", () => {
    const editors = resolveAvailableEditors("darwin", { PATH: "" }, { darwinAppRoots: [] });
    assert.notInclude(editors, "cursor");
  });

  it.effect("detects JetBrains editors via macOS app bundles when not on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const appRoot = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-darwin-apps-" });

      const bundles: ReadonlyArray<readonly [string, string]> = [
        ["Windsurf.app/Contents/Resources/app/bin", "windsurf"],
        ["Visual Studio Code.app/Contents/Resources/app/bin", "code"],
        ["Zed.app/Contents/MacOS", "cli"],
        ["Positron.app/Contents/Resources/app/bin", "positron"],
        ["Sublime Text.app/Contents/SharedSupport/bin", "subl"],
        ["Xcode.app/Contents/Developer/usr/bin", "xed"],
        ["Android Studio.app/Contents/MacOS", "studio"],
        ["IntelliJ IDEA.app/Contents/MacOS", "idea"],
        ["Aqua.app/Contents/MacOS", "aqua"],
        ["CLion.app/Contents/MacOS", "clion"],
        ["DataGrip.app/Contents/MacOS", "datagrip"],
        ["DataSpell.app/Contents/MacOS", "dataspell"],
        ["GoLand.app/Contents/MacOS", "goland"],
        ["PhpStorm.app/Contents/MacOS", "phpstorm"],
        ["PyCharm.app/Contents/MacOS", "pycharm"],
        ["Rider.app/Contents/MacOS", "rider"],
        ["RubyMine.app/Contents/MacOS", "rubymine"],
        ["RustRover.app/Contents/MacOS", "rustrover"],
        ["WebStorm.app/Contents/MacOS", "webstorm"],
      ];
      for (const [dir, binary] of bundles) {
        const bundleDir = path.join(appRoot, dir);
        yield* fs.makeDirectory(bundleDir, { recursive: true });
        const cli = path.join(bundleDir, binary);
        yield* fs.writeFileString(cli, "#!/bin/sh\nexit 0\n");
        yield* fs.chmod(cli, 0o755);
      }

      const opener = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-darwin-bin-" });
      yield* fs.writeFileString(path.join(opener, "open"), "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(path.join(opener, "open"), 0o755);

      const editors = resolveAvailableEditors(
        "darwin",
        { PATH: opener },
        { darwinAppRoots: [appRoot] },
      );
      const editorIdByBinary: Record<string, string> = {
        subl: "sublime-text",
        xed: "xcode",
        studio: "android-studio",
        code: "vscode",
        cli: "zed",
      };
      for (const [, binary] of bundles) {
        assert.include(editors, editorIdByBinary[binary] ?? binary);
      }
    }),
  );

  it.effect("detects PyCharm Professional Edition as the canonical pycharm editor", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const appRoot = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-darwin-apps-" });
      const bundleDir = path.join(appRoot, "PyCharm Professional Edition.app/Contents/MacOS");
      yield* fs.makeDirectory(bundleDir, { recursive: true });
      yield* fs.writeFileString(path.join(bundleDir, "pycharm"), "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(path.join(bundleDir, "pycharm"), 0o755);

      const opener = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-darwin-bin-" });
      yield* fs.writeFileString(path.join(opener, "open"), "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(path.join(opener, "open"), 0o755);

      const editors = resolveAvailableEditors(
        "darwin",
        { PATH: opener },
        { darwinAppRoots: [appRoot] },
      );
      assert.include(editors, "pycharm");
    }),
  );
});

it.layer(NodeServices.layer)("resolveEditorLaunch (darwin app bundle)", (it) => {
  it.effect("uses the macOS Cursor bundle CLI when the bare command isn't on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const appRoot = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-darwin-apps-" });
      const bundleDir = path.join(appRoot, "Cursor.app/Contents/Resources/app/bin");
      yield* fs.makeDirectory(bundleDir, { recursive: true });
      const bundleCli = path.join(bundleDir, "cursor");
      yield* fs.writeFileString(bundleCli, "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(bundleCli, 0o755);

      const launch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "cursor" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [appRoot] },
      );
      assert.deepEqual(launch, { command: bundleCli, args: ["/tmp/workspace"] });
    }),
  );

  it.effect("uses the macOS PyCharm bundle CLI with line-column args when not on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const appRoot = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-darwin-apps-" });
      const bundleDir = path.join(appRoot, "PyCharm.app/Contents/MacOS");
      yield* fs.makeDirectory(bundleDir, { recursive: true });
      const bundleCli = path.join(bundleDir, "pycharm");
      yield* fs.writeFileString(bundleCli, "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(bundleCli, 0o755);

      const launch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/main.py:71:5", editor: "pycharm" },
        "darwin",
        { PATH: "" },
        { darwinAppRoots: [appRoot] },
      );
      assert.deepEqual(launch, {
        command: bundleCli,
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/main.py"],
      });
    }),
  );
});
