import * as FS from "node:fs/promises";
import * as Path from "node:path";

import type { DesktopCliCommandState } from "@ryco/contracts";
import { type RycoDesktopFlavor, rycoDesktopFlavorIdentity } from "@ryco/shared/desktopFlavor";

/**
 * The `ryco` command from Ryco Desktop: a launcher that runs the app's bundled
 * CLI with Electron in Node mode, linked into a folder on the user's PATH.
 * Port of T3 Code's DesktopCliShim and DesktopCliCommand (0678e4e23d and its
 * fixes 3bfbc37dbf, b6fbd181ca).
 */

/** Every file this module writes carries it; nothing without it is replaced or removed. */
export const DESKTOP_CLI_MARKER = "Written by Ryco: runs the desktop app's bundled ryco CLI.";

/** The launcher is well under 2 KiB; never read a large binary another `ryco` links to. */
const MAX_LAUNCHER_BYTES = 16 * 1024;

/** Inside an app bundle or AppImage mount, relative to its root. */
const SERVER_ENTRY = "apps/server/dist/bin.mjs";

const MOVED = "Ryco has moved or been removed. Open it once to update this command.";

export interface DesktopCliCommandEnvironment {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly flavor: RycoDesktopFlavor;
  readonly homeDirectory: string;
  /** The data home this app's backend uses. */
  readonly rycoHome: string;
  /** Electron's executable (`process.execPath`). */
  readonly executable: string;
  /** The bundled server entry (`resolveDesktopBackendEntry`). */
  readonly backendEntry: string;
  /** The AppImage file when running from one (`APPIMAGE`); its mount point changes every run. */
  readonly appImage: string | undefined;
  /** PATH of a new terminal: the app applies the login shell's at launch. */
  readonly path: string | undefined;
}

export type DesktopCliLauncherTarget =
  | { readonly kind: "direct"; readonly executable: string; readonly entry: string }
  | { readonly kind: "appimage"; readonly appImage: string; readonly executableName: string };

const shellWord = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

export function desktopCliCommandName(flavor: RycoDesktopFlavor): string {
  return rycoDesktopFlavorIdentity(flavor).cliCommandName;
}

export function desktopCliLauncherPath(
  environment: Pick<DesktopCliCommandEnvironment, "rycoHome" | "flavor">,
): string {
  return Path.join(environment.rycoHome, "bin", desktopCliCommandName(environment.flavor));
}

/**
 * The launcher script. It embeds the app's home and executable, so `sudo`,
 * which clears the environment, still reaches this app's node.
 * `RYCO_DESKTOP_CLI` names that home: the CLI refuses to start a second node
 * for it (Ryco Desktop runs it), and runs every admin command against it.
 * Ryco keeps an exported `RYCO_HOME`, as the app does; Ryco Nightly never
 * reads it, so its command can never reach Ryco's data.
 */
export function renderDesktopCliLauncher(input: {
  readonly target: DesktopCliLauncherTarget;
  readonly rycoHome: string;
  readonly flavor: RycoDesktopFlavor;
}): string {
  const { target } = input;
  const header = [
    "#!/bin/sh",
    `# ${DESKTOP_CLI_MARKER}`,
    `home=${shellWord(input.rycoHome)}`,
    input.flavor === "nightly"
      ? 'export RYCO_HOME="$home"'
      : 'export RYCO_HOME="${RYCO_HOME:-$home}"',
    'export RYCO_DESKTOP_CLI="$home"',
    "export ELECTRON_RUN_AS_NODE=1",
    `app=${shellWord(target.kind === "appimage" ? target.appImage : target.executable)}`,
    'if [ ! -x "$app" ]; then',
    `  echo "${MOVED}" >&2`,
    "  exit 127",
    "fi",
  ];
  if (target.kind === "direct") {
    return [...header, `exec "$app" ${shellWord(target.entry)} "$@"`, ""].join("\n");
  }
  const run = (root: string) =>
    `"${root}/${target.executableName}" "${root}/resources/app.asar/${SERVER_ENTRY}" "$@"`;
  return [
    ...header,
    // Extract-and-run would make the runtime start the app instead of mounting it.
    "unset APPIMAGE_EXTRACT_AND_RUN",
    // The runtime stays mounted until killed; traps unmount it because background jobs ignore Ctrl-C.
    "work=$(mktemp -d) || exit 1",
    '"$app" --appimage-mount >"$work/mount" 2>/dev/null &',
    "mounter=$!",
    `trap 'kill "$mounter" 2>/dev/null; rm -rf "$work"' EXIT`,
    "trap 'exit 130' INT TERM",
    "mount=",
    'while kill -0 "$mounter" 2>/dev/null; do',
    '  mount=$(head -n 1 "$work/mount")',
    '  [ -d "$mount" ] && break',
    "  mount=",
    "  sleep 0.05",
    "done",
    // Without FUSE the runtime cannot mount (it prints why and exits); extracting the image still works.
    'if [ -z "$mount" ]; then',
    '  (cd "$work" && "$app" --appimage-extract >/dev/null) || { echo "Could not open $app." >&2; exit 1; }',
    '  mount="$work/squashfs-root"',
    "fi",
    run("$mount"),
    "",
  ].join("\n");
}

function launcherTarget(environment: DesktopCliCommandEnvironment): DesktopCliLauncherTarget {
  return environment.appImage
    ? {
        kind: "appimage",
        appImage: environment.appImage,
        executableName: Path.basename(environment.executable),
      }
    : { kind: "direct", executable: environment.executable, entry: environment.backendEntry };
}

/** Folders the command is linked into, in T3's order; the ones on PATH are tried first. */
function linkDirectories(environment: DesktopCliCommandEnvironment): string[] {
  const home = environment.homeDirectory;
  return environment.platform === "darwin"
    ? ["/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`, `${home}/bin`]
    : [`${home}/.local/bin`, `${home}/bin`];
}

const pathEntries = (value: string | undefined) =>
  (value ?? "").split(":").filter((entry) => entry.length > 0);

/** Windows (user PATH in the registry) is a follow-up. */
function isSupported(environment: DesktopCliCommandEnvironment): boolean {
  return (
    environment.isPackaged &&
    (environment.platform === "darwin" || environment.platform === "linux")
  );
}

async function readMarkedFile(target: string): Promise<string | null> {
  try {
    const info = await FS.stat(target);
    if (!info.isFile() || info.size > MAX_LAUNCHER_BYTES) return null;
    const content = await FS.readFile(target, "utf8");
    return content.includes(DESKTOP_CLI_MARKER) ? content : null;
  } catch {
    return null;
  }
}

/** A symlink (to any Ryco launcher) that this app may replace or remove. */
async function isOurLink(link: string): Promise<boolean> {
  try {
    if (!(await FS.lstat(link)).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  return (await readMarkedFile(link)) !== null;
}

/** Whether running `candidate` runs this app's launcher, through our link or directly. */
async function runsOurLauncher(candidate: string, launcher: string): Promise<boolean> {
  if (await isOurLink(candidate)) return true;
  try {
    const [resolved, ours] = await Promise.all([FS.realpath(candidate), FS.realpath(launcher)]);
    if (resolved !== ours) return false;
  } catch {
    return false;
  }
  return (await readMarkedFile(candidate)) !== null;
}

async function isExecutableFile(target: string): Promise<boolean> {
  try {
    if (!(await FS.stat(target)).isFile()) return false;
    await FS.access(target, FS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The command a new terminal runs for this name: the first executable on PATH. */
async function firstOnPath(environment: DesktopCliCommandEnvironment): Promise<string | null> {
  const name = desktopCliCommandName(environment.flavor);
  for (const directory of pathEntries(environment.path)) {
    const candidate = Path.join(directory, name);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

async function installedAt(environment: DesktopCliCommandEnvironment): Promise<string | null> {
  const name = desktopCliCommandName(environment.flavor);
  for (const directory of linkDirectories(environment)) {
    const link = Path.join(directory, name);
    if (await isOurLink(link)) return link;
  }
  return null;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await FS.lstat(target);
    return true;
  } catch {
    return false;
  }
}

const UNSUPPORTED: DesktopCliCommandState = {
  supported: false,
  commandName: "ryco",
  installedPath: null,
  onPath: false,
  launcherPath: null,
};

export async function readDesktopCliCommandState(
  environment: DesktopCliCommandEnvironment,
): Promise<DesktopCliCommandState> {
  if (!isSupported(environment)) return UNSUPPORTED;
  const commandName = desktopCliCommandName(environment.flavor);
  const launcher = desktopCliLauncherPath(environment);
  const [launcherExists, installed, first] = await Promise.all([
    pathExists(launcher),
    installedAt(environment),
    firstOnPath(environment),
  ]);
  const firstIsOurs = first !== null && (await runsOurLauncher(first, launcher));
  return {
    supported: true,
    commandName,
    installedPath: installed,
    onPath: firstIsOurs,
    launcherPath: launcherExists ? launcher : null,
    ...(first !== null && !firstIsOurs ? { shadowedBy: first } : {}),
  };
}

/**
 * Write or refresh the launcher. A file at its path that this app did not
 * write stays untouched. The write goes through a staging file and a rename,
 * so a terminal never runs half a script.
 */
export async function writeDesktopCliLauncher(
  environment: DesktopCliCommandEnvironment,
): Promise<string> {
  const launcher = desktopCliLauncherPath(environment);
  const content = renderDesktopCliLauncher({
    target: launcherTarget(environment),
    rycoHome: environment.rycoHome,
    flavor: environment.flavor,
  });
  let existing: string | null = null;
  try {
    existing = await FS.readFile(launcher, "utf8");
  } catch {
    existing = null;
  }
  if (existing === null && (await pathExists(launcher))) {
    throw new Error(
      `Could not set up the ${desktopCliCommandName(environment.flavor)} launcher at ${launcher}.`,
    );
  }
  if (existing !== null && !existing.includes(DESKTOP_CLI_MARKER)) {
    throw new Error(`${launcher} was not written by Ryco, so it was left alone.`);
  }
  if (existing === content) return launcher;
  await FS.mkdir(Path.dirname(launcher), { recursive: true, mode: 0o700 });
  const staging = `${launcher}.${process.pid}.tmp`;
  try {
    await FS.writeFile(staging, content, { mode: 0o755 });
    await FS.chmod(staging, 0o755);
    await FS.rename(staging, launcher);
  } catch (error) {
    await FS.rm(staging, { force: true });
    throw error;
  }
  return launcher;
}

/**
 * At launch: when the command is installed, point its launcher at this copy of
 * the app (it may have moved, or an update may have changed the bundle). A
 * launcher that was never written stays unwritten.
 */
export async function refreshDesktopCliLauncher(
  environment: DesktopCliCommandEnvironment,
): Promise<void> {
  if (!isSupported(environment)) return;
  if ((await readMarkedFile(desktopCliLauncherPath(environment))) === null) return;
  await writeDesktopCliLauncher(environment);
}

export async function installDesktopCliCommand(
  environment: DesktopCliCommandEnvironment,
): Promise<DesktopCliCommandState> {
  if (!isSupported(environment)) {
    throw new Error("The ryco command needs the installed app on macOS or Linux.");
  }
  const name = desktopCliCommandName(environment.flavor);
  const launcher = await writeDesktopCliLauncher(environment);
  const existing = await installedAt(environment);
  if (existing !== null) {
    const target = await FS.readlink(existing).catch(() => null);
    if (target === launcher) return readDesktopCliCommandState(environment);
    // Ours, but for an older home or path: replace it.
    await FS.rm(existing).catch(() => {
      throw new Error(`Could not replace ${existing}.`);
    });
  }
  const first = await firstOnPath(environment);
  if (first !== null && !(await runsOurLauncher(first, launcher))) {
    throw new Error(
      `Another ${name} at ${first} runs first in a new terminal. Remove it, or run the launcher directly at ${launcher}.`,
    );
  }
  const onPath = pathEntries(environment.path);
  const candidates = linkDirectories(environment);
  for (const directory of [
    ...candidates.filter((candidate) => onPath.includes(candidate)),
    ...candidates.filter((candidate) => !onPath.includes(candidate)),
  ]) {
    try {
      await FS.mkdir(directory, { recursive: true });
      await FS.access(directory, FS.constants.W_OK);
      // Fails when anything is already there: a foreign file is never replaced.
      await FS.symlink(launcher, Path.join(directory, name));
      return readDesktopCliCommandState(environment);
    } catch {
      continue;
    }
  }
  throw new Error(
    `Another ${name} command is already installed, or no folder on your PATH is writable. Run the launcher directly at ${launcher}.`,
  );
}

/** Removes only links to a Ryco launcher; the launcher itself stays, for direct use. */
export async function uninstallDesktopCliCommand(
  environment: DesktopCliCommandEnvironment,
): Promise<DesktopCliCommandState> {
  if (!isSupported(environment)) return UNSUPPORTED;
  const name = desktopCliCommandName(environment.flavor);
  for (const directory of linkDirectories(environment)) {
    const link = Path.join(directory, name);
    if (await isOurLink(link)) {
      await FS.rm(link).catch(() => {
        throw new Error(`Could not remove ${link}.`);
      });
    }
  }
  return readDesktopCliCommandState(environment);
}
