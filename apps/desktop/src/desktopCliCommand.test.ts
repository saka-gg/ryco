import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  DESKTOP_CLI_MARKER,
  type DesktopCliCommandEnvironment,
  type DesktopCliLauncherTarget,
  desktopCliLauncherPath,
  installDesktopCliCommand,
  readDesktopCliCommandState,
  refreshDesktopCliLauncher,
  renderDesktopCliLauncher,
  uninstallDesktopCliCommand,
} from "./desktopCliCommand.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

const tempRoot = () => {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "ryco-cli-command-"));
  directories.push(root);
  return root;
};

const writeExecutable = (target: string, content: string) => {
  FS.mkdirSync(Path.dirname(target), { recursive: true });
  FS.writeFileSync(target, content, { mode: 0o755 });
};

/** Stands in for Electron: prints the environment the launcher set, then its arguments. */
const REPORTER =
  '#!/bin/sh\necho "node=$ELECTRON_RUN_AS_NODE home=$RYCO_HOME desktop=$RYCO_DESKTOP_CLI"\nprintf "%s\\n" "$@"\nexit 3\n';

const writeLauncher = (
  root: string,
  target: DesktopCliLauncherTarget,
  flavor: "stable" | "nightly" = "stable",
) => {
  const launcher = Path.join(root, "bin", "ryco");
  writeExecutable(launcher, renderDesktopCliLauncher({ target, rycoHome: `${root}/home`, flavor }));
  return launcher;
};

const run = (launcher: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}) =>
  ChildProcess.spawnSync(launcher, args, {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });

describe("renderDesktopCliLauncher", () => {
  it("runs the bundled CLI in Node mode with the app's home, quoting every path", () => {
    const root = tempRoot();
    const executable = Path.join(root, "Ryco's App", "Ryco");
    writeExecutable(executable, REPORTER);
    const launcher = writeLauncher(root, {
      kind: "direct",
      executable,
      entry: "/Applications/Ryco's.app/app.asar/apps/server/dist/bin.mjs",
    });
    const result = run(launcher, ["auth", "pairing list"]);
    expect(result.status).toBe(3);
    expect(result.stdout.split("\n")).toEqual([
      `node=1 home=${root}/home desktop=${root}/home`,
      "/Applications/Ryco's.app/app.asar/apps/server/dist/bin.mjs",
      "auth",
      "pairing list",
      "",
    ]);
    expect(FS.readFileSync(launcher, "utf8")).toContain(DESKTOP_CLI_MARKER);
  });

  it("keeps an exported RYCO_HOME for Ryco, and never for Ryco Nightly", () => {
    const root = tempRoot();
    writeExecutable(Path.join(root, "app"), REPORTER);
    const target = {
      kind: "direct",
      executable: Path.join(root, "app"),
      entry: "/bin.mjs",
    } as const;
    const stable = writeLauncher(root, target);
    expect(run(stable, [], { RYCO_HOME: "/elsewhere" }).stdout).toContain(
      `home=/elsewhere desktop=${root}/home`,
    );
    const nightly = writeLauncher(root, target, "nightly");
    expect(run(nightly, [], { RYCO_HOME: `${OS.homedir()}/.ryco` }).stdout).toContain(
      `home=${root}/home desktop=${root}/home`,
    );
  });

  it("says the app moved instead of running something else", () => {
    const root = tempRoot();
    const launcher = writeLauncher(root, {
      kind: "direct",
      executable: Path.join(root, "gone"),
      entry: "/bin.mjs",
    });
    const result = run(launcher, ["--version"]);
    expect(result.status).toBe(127);
    expect(result.stderr).toContain("Ryco has moved or been removed.");
  });

  const fakeAppImage = (canMount: boolean) => {
    const root = tempRoot();
    const image = Path.join(root, "image");
    writeExecutable(Path.join(image, "ryco"), REPORTER);
    const appImage = Path.join(root, "Ryco.AppImage");
    writeExecutable(
      appImage,
      [
        "#!/bin/sh",
        `if [ "$1" = --appimage-extract ]; then cp -R '${image}' squashfs-root; exit 0; fi`,
        '[ "$1" = --appimage-mount ] || exit 9',
        '[ -n "$APPIMAGE_EXTRACT_AND_RUN" ] && exit 8',
        canMount ? `echo '${image}'` : 'echo "Cannot mount AppImage"; exit 1',
        `trap 'touch "${root}/unmounted"; exit 0' TERM`,
        "while :; do sleep 0.05; done",
        "",
      ].join("\n"),
    );
    const launcher = writeLauncher(root, { kind: "appimage", appImage, executableName: "ryco" });
    return { root, image, launcher };
  };

  it("mounts the AppImage to run its CLI, then unmounts it", async () => {
    const { root, image, launcher } = fakeAppImage(true);
    const result = run(launcher, ["--version"]);
    expect(result.status).toBe(3);
    expect(result.stdout).toContain(`${image}/resources/app.asar/apps/server/dist/bin.mjs`);
    // The launcher's exit trap signals the mount process, which unmounts on its own time.
    const unmounted = Path.join(root, "unmounted");
    for (let attempt = 0; attempt < 40 && !FS.existsSync(unmounted); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(FS.existsSync(unmounted)).toBe(true);
  });

  it("extracts the AppImage where it cannot be mounted", () => {
    const { launcher } = fakeAppImage(false);
    const result = run(launcher, ["--version"], { APPIMAGE_EXTRACT_AND_RUN: "1" });
    expect(result.status).toBe(3);
    expect(result.stdout).toMatch(
      /squashfs-root\/resources\/app\.asar\/apps\/server\/dist\/bin\.mjs/,
    );
  });
});

describe("installing the ryco command", () => {
  const setup = (overrides: Partial<DesktopCliCommandEnvironment> = {}) => {
    const root = tempRoot();
    const homeDirectory = Path.join(root, "user");
    const localBin = Path.join(homeDirectory, ".local", "bin");
    const executable = Path.join(root, "Ryco");
    writeExecutable(executable, REPORTER);
    const environment: DesktopCliCommandEnvironment = {
      platform: "linux",
      isPackaged: true,
      flavor: "stable",
      homeDirectory,
      rycoHome: Path.join(homeDirectory, ".ryco"),
      executable,
      backendEntry: "/app.asar/apps/server/dist/bin.mjs",
      appImage: undefined,
      path: [localBin, "/usr/bin", "/bin"].join(":"),
      ...overrides,
    };
    return { root, homeDirectory, localBin, environment };
  };

  it("links the launcher into the first writable folder on PATH", async () => {
    const { localBin, environment } = setup();
    const state = await installDesktopCliCommand(environment);
    const launcher = desktopCliLauncherPath(environment);
    expect(state).toEqual({
      supported: true,
      commandName: "ryco",
      installedPath: Path.join(localBin, "ryco"),
      onPath: true,
      launcherPath: launcher,
    });
    expect(FS.readlinkSync(Path.join(localBin, "ryco"))).toBe(launcher);
    expect(FS.statSync(launcher).mode & 0o777).toBe(0o755);
    expect(FS.statSync(Path.dirname(launcher)).mode & 0o777).toBe(0o700);
    expect(run(Path.join(localBin, "ryco"), ["doctor"]).stdout).toContain("node=1");
    // Installing again changes nothing.
    expect(await installDesktopCliCommand(environment)).toEqual(state);
  });

  it("uses ryco-nightly for Ryco Nightly", async () => {
    const { localBin, homeDirectory, environment } = setup({ flavor: "nightly" });
    const nightly = { ...environment, rycoHome: Path.join(homeDirectory, ".ryco-nightly") };
    const state = await installDesktopCliCommand(nightly);
    expect(state.commandName).toBe("ryco-nightly");
    expect(state.installedPath).toBe(Path.join(localBin, "ryco-nightly"));
    expect(FS.existsSync(Path.join(localBin, "ryco"))).toBe(false);
  });

  it("refuses to install behind another ryco a new terminal runs first", async () => {
    const { root, localBin, environment } = setup();
    const npmBin = Path.join(root, "npm", "bin");
    writeExecutable(Path.join(npmBin, "ryco"), "#!/bin/sh\necho npm\n");
    const shadowed = { ...environment, path: `${npmBin}:${environment.path}` };
    await expect(installDesktopCliCommand(shadowed)).rejects.toThrow(
      `Another ryco at ${Path.join(npmBin, "ryco")} runs first in a new terminal.`,
    );
    expect(FS.existsSync(Path.join(localBin, "ryco"))).toBe(false);
    expect((await readDesktopCliCommandState(shadowed)).shadowedBy).toBe(Path.join(npmBin, "ryco"));
  });

  it("never replaces a file it did not write", async () => {
    const { homeDirectory, localBin, environment } = setup();
    // An unrelated `ryco` in ~/.local/bin, not executable, so not first on PATH.
    FS.mkdirSync(localBin, { recursive: true });
    FS.writeFileSync(Path.join(localBin, "ryco"), "someone else's\n", { mode: 0o644 });
    const state = await installDesktopCliCommand(environment);
    expect(FS.readFileSync(Path.join(localBin, "ryco"), "utf8")).toBe("someone else's\n");
    expect(state.installedPath).toBe(Path.join(homeDirectory, "bin", "ryco"));
    expect(state.onPath).toBe(false);

    // Nor an unmarked file where the launcher goes.
    const other = setup();
    const launcher = desktopCliLauncherPath(other.environment);
    writeExecutable(launcher, "#!/bin/sh\necho mine\n");
    await expect(installDesktopCliCommand(other.environment)).rejects.toThrow(
      "was not written by Ryco",
    );
    expect(FS.readFileSync(launcher, "utf8")).toBe("#!/bin/sh\necho mine\n");

    // Nor a file a link at the staging name points to: the link is replaced, never written through.
    const linked = setup();
    const linkedLauncher = desktopCliLauncherPath(linked.environment);
    const victim = Path.join(linked.homeDirectory, "notes.txt");
    FS.mkdirSync(Path.dirname(linkedLauncher), { recursive: true });
    FS.writeFileSync(victim, "my notes\n", { mode: 0o600 });
    FS.symlinkSync(victim, `${linkedLauncher}.${process.pid}.tmp`);
    await installDesktopCliCommand(linked.environment);
    expect(FS.readFileSync(victim, "utf8")).toBe("my notes\n");
    expect(FS.statSync(victim).mode & 0o777).toBe(0o600);
    expect(FS.lstatSync(linkedLauncher).isFile()).toBe(true);
    expect(FS.readFileSync(linkedLauncher, "utf8")).toContain(DESKTOP_CLI_MARKER);
  });

  it("removes only its own links, and never reads a large file to decide", async () => {
    const { root, homeDirectory, localBin, environment } = setup();
    await installDesktopCliCommand(environment);
    const big = Path.join(root, "big");
    FS.writeFileSync(big, `${"x".repeat(20 * 1024)}\n# ${DESKTOP_CLI_MARKER}\n`);
    FS.mkdirSync(Path.join(homeDirectory, "bin"), { recursive: true });
    FS.symlinkSync(big, Path.join(homeDirectory, "bin", "ryco"));

    const state = await uninstallDesktopCliCommand(environment);
    expect(FS.existsSync(Path.join(localBin, "ryco"))).toBe(false);
    expect(FS.readlinkSync(Path.join(homeDirectory, "bin", "ryco"))).toBe(big);
    expect(state.installedPath).toBeNull();
    // The launcher stays, for direct use.
    expect(state.launcherPath).toBe(desktopCliLauncherPath(environment));
  });

  it("follows the app at launch only when the command was installed", async () => {
    const { root, environment } = setup();
    await refreshDesktopCliLauncher(environment);
    expect(FS.existsSync(desktopCliLauncherPath(environment))).toBe(false);

    await installDesktopCliCommand(environment);
    const moved = Path.join(root, "moved", "Ryco");
    writeExecutable(moved, REPORTER);
    await refreshDesktopCliLauncher({ ...environment, executable: moved });
    expect(FS.readFileSync(desktopCliLauncherPath(environment), "utf8")).toContain(
      `app='${moved}'`,
    );
  });

  it("is not offered outside an installed app on macOS or Linux", async () => {
    for (const overrides of [{ isPackaged: false }, { platform: "win32" as const }]) {
      const { environment } = setup(overrides);
      expect((await readDesktopCliCommandState(environment)).supported).toBe(false);
      await expect(installDesktopCliCommand(environment)).rejects.toThrow();
      expect(FS.existsSync(desktopCliLauncherPath(environment))).toBe(false);
    }
  });
});
