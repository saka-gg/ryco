/**
 * Open - Browser/editor launch service interface.
 *
 * Owns process launch helpers for opening URLs in a browser and workspace
 * paths in a configured editor.
 *
 * @module Open
 */
import { spawn } from "node:child_process";

import { EDITORS, OpenError, type EditorId } from "@ryco/contracts";
import { isCommandAvailable, type CommandAvailabilityOptions } from "@ryco/shared/shell";
import { Context, Effect, Layer } from "effect";

// ==============================
// Definitions
// ==============================

export { OpenError };
export { isCommandAvailable } from "@ryco/shared/shell";

export interface OpenInEditorInput {
  readonly cwd: string;
  readonly editor: EditorId;
}

interface EditorLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const TARGET_WITH_POSITION_PATTERN = /^(.*?):(\d+)(?::(\d+))?$/;

function parseTargetPathAndPosition(target: string): {
  path: string;
  line: string;
  column: string | undefined;
} | null {
  const match = TARGET_WITH_POSITION_PATTERN.exec(target);
  if (!match?.[1] || !match[2]) {
    return null;
  }

  return {
    path: match[1],
    line: match[2],
    column: match[3],
  };
}

function resolveCommandEditorArgs(
  editor: (typeof EDITORS)[number],
  target: string,
): ReadonlyArray<string> {
  const parsedTarget = parseTargetPathAndPosition(target);

  switch (editor.launchStyle) {
    case "direct-path":
      return [target];
    case "goto":
      return parsedTarget ? ["--goto", target] : [target];
    case "line": {
      if (!parsedTarget) {
        return [target];
      }

      return ["--line", parsedTarget.line, parsedTarget.path];
    }
    case "line-column": {
      if (!parsedTarget) {
        return [target];
      }

      const { path, line, column } = parsedTarget;
      return [...(line ? ["--line", line] : []), ...(column ? ["--column", column] : []), path];
    }
    case "nova-line-column": {
      if (!parsedTarget) {
        return [target];
      }

      const position = parsedTarget.column
        ? `${parsedTarget.line}:${parsedTarget.column}`
        : parsedTarget.line;
      return [parsedTarget.path, "--line", position];
    }
  }
}

function resolveEditorArgs(
  editor: (typeof EDITORS)[number],
  target: string,
): ReadonlyArray<string> {
  const baseArgs = "baseArgs" in editor ? editor.baseArgs : [];
  return [...baseArgs, ...resolveCommandEditorArgs(editor, target)];
}

function resolveAvailableCommand(
  commands: ReadonlyArray<string>,
  options: CommandAvailabilityOptions = {},
): string | null {
  for (const command of commands) {
    if (isCommandAvailable(command, options)) {
      return command;
    }
  }
  return null;
}

const DARWIN_APP_BUNDLE_RELATIVE_CLI_PATHS: Partial<Record<EditorId, readonly string[]>> = {
  cursor: ["Cursor.app/Contents/Resources/app/bin/cursor"],
  windsurf: ["Windsurf.app/Contents/Resources/app/bin/windsurf"],
  trae: ["Trae.app/Contents/Resources/app/bin/trae"],
  kiro: ["Kiro.app/Contents/Resources/app/bin/kiro"],
  vscode: ["Visual Studio Code.app/Contents/Resources/app/bin/code"],
  "vscode-insiders": ["Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders"],
  vscodium: ["VSCodium.app/Contents/Resources/app/bin/codium"],
  zed: ["Zed.app/Contents/MacOS/cli", "Zed Preview.app/Contents/MacOS/cli"],
  positron: ["Positron.app/Contents/Resources/app/bin/positron"],
  "sublime-text": ["Sublime Text.app/Contents/SharedSupport/bin/subl"],
  xcode: ["Xcode.app/Contents/Developer/usr/bin/xed"],
  "android-studio": ["Android Studio.app/Contents/MacOS/studio"],
  idea: [
    "IntelliJ IDEA.app/Contents/MacOS/idea",
    "IntelliJ IDEA Ultimate.app/Contents/MacOS/idea",
    "IntelliJ IDEA CE.app/Contents/MacOS/idea",
    "IntelliJ IDEA Community Edition.app/Contents/MacOS/idea",
  ],
  aqua: ["Aqua.app/Contents/MacOS/aqua"],
  clion: ["CLion.app/Contents/MacOS/clion"],
  datagrip: ["DataGrip.app/Contents/MacOS/datagrip"],
  dataspell: ["DataSpell.app/Contents/MacOS/dataspell"],
  goland: ["GoLand.app/Contents/MacOS/goland"],
  phpstorm: ["PhpStorm.app/Contents/MacOS/phpstorm"],
  pycharm: [
    "PyCharm.app/Contents/MacOS/pycharm",
    "PyCharm Professional Edition.app/Contents/MacOS/pycharm",
    "PyCharm CE.app/Contents/MacOS/pycharm",
    "PyCharm Community Edition.app/Contents/MacOS/pycharm",
  ],
  rider: ["Rider.app/Contents/MacOS/rider", "JetBrains Rider.app/Contents/MacOS/rider"],
  rubymine: ["RubyMine.app/Contents/MacOS/rubymine"],
  rustrover: ["RustRover.app/Contents/MacOS/rustrover"],
  webstorm: ["WebStorm.app/Contents/MacOS/webstorm"],
};

function defaultDarwinAppRoots(env: NodeJS.ProcessEnv): readonly string[] {
  const home = env.HOME ?? "";
  return home.length > 0 ? ["/Applications", `${home}/Applications`] : ["/Applications"];
}

export interface ResolveOptions {
  /**
   * macOS-only: directories to search for app bundles when the editor's CLI
   * isn't on PATH. Defaults to `/Applications` and `~/Applications`. Tests
   * pass an isolated array to keep results deterministic.
   */
  readonly darwinAppRoots?: readonly string[];
  /** macOS-only: injectable Terminal.app executables used by deterministic tests. */
  readonly darwinTerminalAppPaths?: readonly string[];
}

function resolveDarwinBundleCli(
  editor: EditorId,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  options: ResolveOptions,
): string | null {
  if (platform !== "darwin") return null;
  const relativePaths = DARWIN_APP_BUNDLE_RELATIVE_CLI_PATHS[editor];
  if (!relativePaths) return null;
  const roots = options.darwinAppRoots ?? defaultDarwinAppRoots(env);
  for (const root of roots) {
    for (const rel of relativePaths) {
      const candidate = `${root}/${rel}`;
      if (isCommandAvailable(candidate, { platform, env })) return candidate;
    }
  }
  return null;
}

function fileManagerCommandForPlatform(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "open";
    case "win32":
      return "explorer";
    default:
      return "xdg-open";
  }
}

const LINUX_TERMINAL_COMMANDS = [
  {
    command: "gnome-terminal",
    args: (cwd: string): ReadonlyArray<string> => [`--working-directory=${cwd}`],
  },
  { command: "konsole", args: (cwd: string): ReadonlyArray<string> => ["--workdir", cwd] },
  {
    command: "xfce4-terminal",
    args: (cwd: string): ReadonlyArray<string> => [`--working-directory=${cwd}`],
  },
  { command: "kitty", args: (cwd: string): ReadonlyArray<string> => ["--directory", cwd] },
  {
    command: "wezterm",
    args: (cwd: string): ReadonlyArray<string> => ["start", "--cwd", cwd],
  },
  {
    command: "alacritty",
    args: (cwd: string): ReadonlyArray<string> => ["--working-directory", cwd],
  },
  {
    command: "ghostty",
    args: (cwd: string): ReadonlyArray<string> => [`--working-directory=${cwd}`],
  },
] as const;

function resolveTerminalLaunch(
  cwd: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  options: ResolveOptions,
): EditorLaunch | null {
  if (platform === "darwin") {
    if (!isCommandAvailable("open", { platform, env })) return null;
    const terminalAppPaths = options.darwinTerminalAppPaths ?? [
      "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
      "/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
    ];
    if (!terminalAppPaths.some((path) => isCommandAvailable(path, { platform, env }))) return null;
    return { command: "open", args: ["-a", "Terminal", cwd] };
  }

  if (platform === "win32") {
    const command = resolveAvailableCommand(["wt", "wt.exe"], { platform, env });
    return command ? { command, args: ["-d", cwd] } : null;
  }

  if (platform === "linux") {
    for (const terminal of LINUX_TERMINAL_COMMANDS) {
      if (isCommandAvailable(terminal.command, { platform, env })) {
        return { command: terminal.command, args: terminal.args(cwd) };
      }
    }
  }

  return null;
}

function resolvePlatformEditorLaunch(
  editor: (typeof EDITORS)[number],
  cwd: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  options: ResolveOptions,
  requireAvailable = true,
): EditorLaunch | null {
  if (!("platformLauncher" in editor)) return null;
  if (editor.platformLauncher === "terminal") {
    return resolveTerminalLaunch(cwd, platform, env, options);
  }

  const command = fileManagerCommandForPlatform(platform);
  return !requireAvailable || isCommandAvailable(command, { platform, env })
    ? { command, args: [cwd] }
    : null;
}

function supportsPlatform(editor: (typeof EDITORS)[number], platform: NodeJS.Platform): boolean {
  return !("platforms" in editor) || (editor.platforms as readonly string[]).includes(platform);
}

/**
 * How long the process's own editor scan is reused. `serverGetConfig` rebuilds
 * the config on every call, and the scan stats every PATH entry for each editor
 * plus macOS app bundles (several ms of synchronous I/O). A PATH change
 * invalidates it immediately; newly installed apps show up within this window.
 */
const AVAILABLE_EDITORS_CACHE_TTL_MS = 5 * 60_000;

let availableEditorsCache: {
  readonly key: string;
  readonly scannedAt: number;
  readonly editors: ReadonlyArray<EditorId>;
} | null = null;

export function resolveAvailableEditors(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveOptions = {},
): ReadonlyArray<EditorId> {
  // Only the server's own environment is cached; explicit inputs always scan.
  if (
    env !== process.env ||
    options.darwinAppRoots !== undefined ||
    options.darwinTerminalAppPaths !== undefined
  ) {
    return scanAvailableEditors(platform, env, options);
  }
  const key = `${platform}:${env.PATH ?? ""}`;
  const now = Date.now();
  if (
    availableEditorsCache !== null &&
    availableEditorsCache.key === key &&
    now - availableEditorsCache.scannedAt < AVAILABLE_EDITORS_CACHE_TTL_MS
  ) {
    return availableEditorsCache.editors;
  }
  const editors = scanAvailableEditors(platform, env, options);
  availableEditorsCache = { key, scannedAt: now, editors };
  return editors;
}

function scanAvailableEditors(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  options: ResolveOptions,
): ReadonlyArray<EditorId> {
  const available: EditorId[] = [];

  for (const editor of EDITORS) {
    if (!supportsPlatform(editor, platform)) continue;

    if (editor.commands === null) {
      if (resolvePlatformEditorLaunch(editor, ".", platform, env, options)) {
        available.push(editor.id);
      }
      continue;
    }

    const command = resolveAvailableCommand(editor.commands, { platform, env });
    if (command !== null) {
      available.push(editor.id);
      continue;
    }
    if (resolveDarwinBundleCli(editor.id, platform, env, options) !== null) {
      available.push(editor.id);
    }
  }

  return available;
}

/**
 * OpenShape - Service API for browser and editor launch actions.
 */
export interface OpenShape {
  /**
   * Open a URL target in the default browser.
   */
  readonly openBrowser: (target: string) => Effect.Effect<void, OpenError>;

  /**
   * Open a workspace path in a selected editor integration.
   *
   * Launches the editor as a detached process so server startup is not blocked.
   */
  readonly openInEditor: (input: OpenInEditorInput) => Effect.Effect<void, OpenError>;
}

/**
 * Open - Service tag for browser/editor launch operations.
 */
export class Open extends Context.Service<Open, OpenShape>()("ryco/open") {}

// ==============================
// Implementations
// ==============================

export const resolveEditorLaunch = Effect.fn("resolveEditorLaunch")(function* (
  input: OpenInEditorInput,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveOptions = {},
): Effect.fn.Return<EditorLaunch, OpenError> {
  yield* Effect.annotateCurrentSpan({
    "open.editor": input.editor,
    "open.cwd": input.cwd,
    "open.platform": platform,
  });
  const editorDef = EDITORS.find((editor) => editor.id === input.editor);
  if (!editorDef) {
    return yield* new OpenError({ message: `Unknown editor: ${input.editor}` });
  }
  if (!supportsPlatform(editorDef, platform)) {
    return yield* new OpenError({
      message: `${editorDef.label} is not supported on ${platform}`,
    });
  }

  if (editorDef.commands) {
    const command =
      resolveAvailableCommand(editorDef.commands, { platform, env }) ??
      resolveDarwinBundleCli(editorDef.id, platform, env, options) ??
      editorDef.commands[0];
    return {
      command,
      args: resolveEditorArgs(editorDef, input.cwd),
    };
  }

  const platformLaunch = resolvePlatformEditorLaunch(
    editorDef,
    input.cwd,
    platform,
    env,
    options,
    false,
  );
  if (!platformLaunch) {
    return yield* new OpenError({ message: `${editorDef.label} is not available` });
  }
  return platformLaunch;
});

export const launchDetached = (launch: EditorLaunch) =>
  Effect.gen(function* () {
    if (!isCommandAvailable(launch.command)) {
      return yield* new OpenError({ message: `Editor command not found: ${launch.command}` });
    }

    yield* Effect.callback<void, OpenError>((resume) => {
      let child;
      try {
        const spawnCommand = process.platform === "win32" ? "cmd.exe" : launch.command;
        const spawnArgs =
          process.platform === "win32" ? ["/c", launch.command, ...launch.args] : [...launch.args];
        child = spawn(spawnCommand, spawnArgs, {
          detached: true,
          stdio: "ignore",
          shell: false,
        });
      } catch (error) {
        return resume(
          Effect.fail(new OpenError({ message: "failed to spawn detached process", cause: error })),
        );
      }

      const handleSpawn = () => {
        child.unref();
        resume(Effect.void);
      };

      child.once("spawn", handleSpawn);
      child.once("error", (cause) =>
        resume(Effect.fail(new OpenError({ message: "failed to spawn detached process", cause }))),
      );
    });
  });

const make = Effect.gen(function* () {
  const open = yield* Effect.tryPromise({
    try: () => import("open"),
    catch: (cause) => new OpenError({ message: "failed to load browser opener", cause }),
  });

  return {
    openBrowser: (target) =>
      Effect.tryPromise({
        try: () => open.default(target),
        catch: (cause) => new OpenError({ message: "Browser auto-open failed", cause }),
      }),
    openInEditor: (input) => Effect.flatMap(resolveEditorLaunch(input), launchDetached),
  } satisfies OpenShape;
});

export const OpenLive = Layer.effect(Open, make);
