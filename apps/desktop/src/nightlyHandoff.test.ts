import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  type CommandOutput,
  flavorAppExecutable,
  type NightlyHandoffEnvironment,
  nightlyLaunchVariables,
  openNightly,
  ownAppTeamId,
  readNightlyState,
  switchBackToRyco,
} from "./nightlyHandoff.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) FS.rmSync(root, { recursive: true, force: true });
});

function writeApp(folder: string, name: string, bundleId: string): string {
  const bundle = Path.join(folder, `${name}.app`);
  FS.mkdirSync(Path.join(bundle, "Contents", "MacOS"), { recursive: true });
  FS.writeFileSync(
    Path.join(bundle, "Contents", "Info.plist"),
    `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleExecutable</key><string>${name}</string></dict></plist>`,
  );
  FS.writeFileSync(Path.join(bundle, "Contents", "MacOS", name), "#!/bin/sh\n", { mode: 0o755 });
  return bundle;
}

/** `codesign` as it answers for a bundle signed by `teamId` as `identifier`. */
function codesignAnswering(
  signatures: Readonly<Record<string, { teamId: string; identifier: string }>>,
) {
  const calls: Array<ReadonlyArray<string>> = [];
  const readCommand = async (
    _command: string,
    args: ReadonlyArray<string>,
  ): Promise<CommandOutput> => {
    calls.push(args);
    const signature = signatures[args.at(-1) ?? ""];
    if (signature === undefined)
      return { status: 1, stdout: "", stderr: "code object is not signed at all" };
    if (args[0] === "--verify") return { status: 0, stdout: "", stderr: "" };
    return {
      status: 0,
      stdout: "",
      stderr: `Identifier=${signature.identifier}\nTeamIdentifier=${signature.teamId}\n`,
    };
  };
  return { readCommand, calls };
}

function setup(flavor: "stable" | "nightly", overrides: Partial<NightlyHandoffEnvironment> = {}) {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "ryco-nightly-handoff-"));
  roots.push(root);
  const applications = Path.join(root, "Applications");
  FS.mkdirSync(applications);
  const opened: Array<{ bundle: string; variables: Readonly<Record<string, string>> }> = [];
  const environment: NightlyHandoffEnvironment = {
    platform: "darwin",
    flavor,
    homeDirectory: root,
    rycoHome: Path.join(root, flavor === "stable" ? ".ryco" : ".ryco-nightly"),
    nightlyHome: Path.join(root, ".ryco-nightly"),
    executable: "/Applications/Ryco.app/Contents/MacOS/Ryco",
    env: {},
    expectedTeamId: null,
    applicationsDirectories: [applications],
    openApp: async (bundle, variables) => {
      opened.push({ bundle, variables });
    },
    ...overrides,
  };
  return { root, applications, environment, opened };
}

const requestFile = (home: string) => Path.join(home, "import-requested.json");

describe("finding the other app", () => {
  it("opens a bundle only when its Info.plist names that app's bundle id", async () => {
    const { applications } = setup("stable");
    const nightly = writeApp(applications, "Ryco Nightly", "com.laurinfrank.ryco.nightly");
    expect(await flavorAppExecutable(nightly, "nightly")).toBe(
      Path.join(nightly, "Contents", "MacOS", "Ryco Nightly"),
    );
    expect(await flavorAppExecutable(Path.join(applications, "Ryco Nightly.app"), "stable")).toBe(
      null,
    );
    writeApp(applications, "Impostor", "com.example.other");
    expect(
      await flavorAppExecutable(Path.join(applications, "Impostor.app"), "nightly"),
    ).toBeNull();
  });

  it("never takes a linked bundle for the app", async () => {
    const { root, applications, environment } = setup("stable");
    const elsewhere = Path.join(root, "elsewhere");
    FS.mkdirSync(elsewhere);
    const real = writeApp(elsewhere, "Ryco Nightly", "com.laurinfrank.ryco.nightly");
    FS.symlinkSync(real, Path.join(applications, "Ryco Nightly.app"));
    expect(await readNightlyState(environment)).toMatchObject({ otherAppInstalled: false });
  });

  it("reports Ryco Nightly as not installed when only a foreign app has its name", async () => {
    const { applications, environment } = setup("stable");
    writeApp(applications, "Ryco Nightly", "com.example.lookalike");
    expect(await readNightlyState(environment)).toMatchObject({
      flavor: "stable",
      otherAppInstalled: false,
    });
  });
});

describe("opening Ryco Nightly from Ryco", () => {
  it("asks for a copy only in Ryco Nightly's home, for this launch only, and passes only the hand-off", async () => {
    const { applications, environment, opened } = setup("stable", {
      env: {
        PATH: "/usr/bin",
        RYCO_HOME: "/somewhere/.ryco",
        RYCO_PORT: "7926",
        RYCO_NIGHTLY_HOME: "/kept/nightly-home",
        ELECTRON_RUN_AS_NODE: "1",
      },
    });
    const nightly = writeApp(applications, "Ryco Nightly", "com.laurinfrank.ryco.nightly");
    FS.mkdirSync(environment.rycoHome, { recursive: true });
    const stableBefore = FS.readdirSync(environment.rycoHome);

    await openNightly(environment, { copyData: true, now: new Date("2026-10-31T08:00:00Z") });

    const request = JSON.parse(FS.readFileSync(requestFile(environment.nightlyHome), "utf8"));
    expect(request).toEqual({
      version: 1,
      requestedAt: "2026-10-31T08:00:00.000Z",
      sourceHomeDir: environment.rycoHome,
      token: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/u),
    });
    expect(FS.readdirSync(environment.nightlyHome)).toEqual(["import-requested.json"]);
    expect(FS.readdirSync(environment.rycoHome)).toEqual(stableBefore);
    // Through macOS, with nothing of this app's environment: only the hand-off variables.
    expect(opened).toEqual([
      {
        bundle: nightly,
        variables: {
          RYCO_STABLE_HOME: environment.rycoHome,
          RYCO_STABLE_EXECUTABLE: environment.executable,
          RYCO_NIGHTLY_HOME: "/kept/nightly-home",
          RYCO_FLAVOR_IMPORT_TOKEN: request.token,
        },
      },
    ]);

    // Every request gets its own token.
    await openNightly(environment, { copyData: true });
    const next = JSON.parse(FS.readFileSync(requestFile(environment.nightlyHome), "utf8"));
    expect(next.token).not.toBe(request.token);
    expect(opened[1]?.variables.RYCO_FLAVOR_IMPORT_TOKEN).toBe(next.token);
  });

  it("opens Ryco Nightly as it is without a token", async () => {
    const { applications, environment, opened } = setup("stable");
    writeApp(applications, "Ryco Nightly", "com.laurinfrank.ryco.nightly");
    await openNightly(environment, { copyData: false });
    expect(opened[0]?.variables).not.toHaveProperty("RYCO_FLAVOR_IMPORT_TOKEN");
    expect(FS.existsSync(requestFile(environment.nightlyHome))).toBe(false);
  });

  it("refuses to ask for a copy while Ryco Nightly's node runs", async () => {
    const { applications, environment, opened } = setup("stable");
    writeApp(applications, "Ryco Nightly", "com.laurinfrank.ryco.nightly");
    FS.mkdirSync(Path.join(environment.nightlyHome, "userdata"), { recursive: true });
    FS.writeFileSync(
      Path.join(environment.nightlyHome, "userdata", "server-runtime.json"),
      JSON.stringify({ pid: process.pid }),
    );
    expect(await readNightlyState(environment)).toMatchObject({ nightlyRunning: true });
    await expect(openNightly(environment, { copyData: true })).rejects.toThrow(
      /Quit Ryco Nightly/u,
    );
    expect(FS.existsSync(requestFile(environment.nightlyHome))).toBe(false);
    expect(opened).toEqual([]);
    // Opening it as it is still works.
    await openNightly(environment, { copyData: false });
    expect(opened).toHaveLength(1);
  });

  it("refuses a copy when Ryco Nightly's data folder is Ryco's own, through a link or inside it", async () => {
    const { root, applications, environment, opened } = setup("stable");
    writeApp(applications, "Ryco Nightly", "com.laurinfrank.ryco.nightly");
    FS.mkdirSync(environment.rycoHome, { recursive: true });
    FS.symlinkSync(environment.rycoHome, environment.nightlyHome);
    await expect(openNightly(environment, { copyData: true })).rejects.toThrow(/Ryco's own/u);
    const inside = { ...environment, nightlyHome: Path.join(environment.rycoHome, "nightly") };
    await expect(openNightly(inside, { copyData: true })).rejects.toThrow(/Ryco's own/u);
    expect(FS.readdirSync(environment.rycoHome)).toEqual([]);
    expect(opened).toEqual([]);
    expect(root).toBeTruthy();
  });

  it("opens only a Ryco Nightly signed by Ryco's own team and as Ryco Nightly", async () => {
    const { applications, environment, opened } = setup("stable");
    const bundle = writeApp(applications, "Ryco Nightly", "com.laurinfrank.ryco.nightly");
    const foreign = codesignAnswering({
      [bundle]: { teamId: "OTHERTEAM1", identifier: "com.laurinfrank.ryco.nightly" },
    });
    const signed = {
      ...environment,
      expectedTeamId: "RYCOTEAM01",
      readCommand: foreign.readCommand,
    };
    await expect(openNightly(signed, { copyData: true })).rejects.toThrow(
      /not signed by Ryco's team/u,
    );
    // Checked before anything is written.
    expect(FS.existsSync(environment.nightlyHome)).toBe(false);

    const wrongId = codesignAnswering({
      [bundle]: { teamId: "RYCOTEAM01", identifier: "com.example.lookalike" },
    });
    await expect(
      openNightly({ ...signed, readCommand: wrongId.readCommand }, { copyData: false }),
    ).rejects.toThrow(/not signed by Ryco's team/u);
    const unsigned = codesignAnswering({});
    await expect(
      openNightly({ ...signed, readCommand: unsigned.readCommand }, { copyData: false }),
    ).rejects.toThrow(/not signed by Ryco's team/u);
    await expect(
      openNightly({ ...environment, expectedTeamId: "unavailable" }, { copyData: false }),
    ).rejects.toThrow(/its own signature/u);
    expect(opened).toEqual([]);

    const ours = codesignAnswering({
      [bundle]: { teamId: "RYCOTEAM01", identifier: "com.laurinfrank.ryco.nightly" },
    });
    await openNightly({ ...signed, readCommand: ours.readCommand }, { copyData: false });
    expect(opened).toHaveLength(1);
    expect(ours.calls[0]).toEqual(["--verify", "--deep", "--strict", bundle]);
  });

  it("leaves no request behind when macOS could not open Ryco Nightly", async () => {
    const { applications, environment } = setup("stable", {
      openApp: async () => {
        throw new Error("LSOpenURLsWithRole() failed");
      },
    });
    writeApp(applications, "Ryco Nightly", "com.laurinfrank.ryco.nightly");
    await expect(openNightly(environment, { copyData: true })).rejects.toThrow(/LSOpen/u);
    expect(FS.readdirSync(environment.nightlyHome)).toEqual([]);
  });

  it("is offered only on Ryco, and only where it can find Ryco Nightly", async () => {
    const nightlySide = setup("nightly");
    await expect(openNightly(nightlySide.environment, { copyData: false })).rejects.toThrow();
    const linux = setup("stable", { platform: "linux" });
    await expect(openNightly(linux.environment, { copyData: false })).rejects.toThrow(
      /not installed/u,
    );
  });
});

describe("switching back from Ryco Nightly", () => {
  it("opens Ryco through macOS with none of Nightly's environment, and copies nothing back", async () => {
    const { applications, environment, opened } = setup("nightly");
    const stable = writeApp(applications, "Ryco", "com.laurinfrank.ryco");
    const switching = {
      ...environment,
      env: {
        PATH: "/usr/bin",
        RYCO_HOME: environment.nightlyHome,
        RYCO_STABLE_HOME: Path.join(environment.homeDirectory, ".ryco"),
        RYCO_STABLE_EXECUTABLE: "/not/an/app",
      },
    };
    await switchBackToRyco(switching);
    expect(opened).toEqual([{ bundle: stable, variables: {} }]);
    expect(FS.existsSync(environment.nightlyHome)).toBe(false);
  });

  it("hands Ryco back its own data folder when it was not the usual one, never Nightly's", async () => {
    const { applications, environment, opened } = setup("nightly");
    writeApp(applications, "Ryco", "com.laurinfrank.ryco");
    await switchBackToRyco({ ...environment, env: { RYCO_STABLE_HOME: "/data/ryco-home" } });
    await switchBackToRyco({ ...environment, env: { RYCO_STABLE_HOME: environment.nightlyHome } });
    await switchBackToRyco({
      ...environment,
      env: { RYCO_STABLE_HOME: Path.join(environment.nightlyHome, "inner") },
    });
    expect(opened.map((entry) => entry.variables)).toEqual([
      { RYCO_HOME: "/data/ryco-home" },
      {},
      {},
    ]);
  });

  it("reads how the last copy went", async () => {
    const { environment } = setup("nightly");
    FS.mkdirSync(environment.rycoHome, { recursive: true });
    FS.writeFileSync(
      Path.join(environment.rycoHome, "import-result.json"),
      JSON.stringify({ version: 1, completedAt: "2026-10-31T08:01:00.000Z", ok: true }),
    );
    expect((await readNightlyState(environment)).lastImport).toEqual({
      version: 1,
      completedAt: "2026-10-31T08:01:00.000Z",
      ok: true,
    });
  });
});

describe("nightlyLaunchVariables", () => {
  it("passes only the hand-off, Nightly's own home when given, and the token", () => {
    const { environment } = setup("stable", {
      env: {
        HOME: "/h",
        RYCO_DESKTOP_CLI: "/h/.ryco",
        RYCO_NIGHTLY_HOME: "/n",
        ELECTRON_NO_ASAR: "1",
      },
    });
    expect(nightlyLaunchVariables(environment, "t".repeat(32))).toEqual({
      RYCO_STABLE_HOME: environment.rycoHome,
      RYCO_STABLE_EXECUTABLE: environment.executable,
      RYCO_NIGHTLY_HOME: "/n",
      RYCO_FLAVOR_IMPORT_TOKEN: "t".repeat(32),
    });
  });
});

describe("ownAppTeamId", () => {
  const answer = (output: CommandOutput) => async (): Promise<CommandOutput> => output;
  const packaged = {
    platform: "darwin" as const,
    isPackaged: true,
    executable: "/Applications/Ryco.app/Contents/MacOS/Ryco",
  };
  it("reads the team id of a signed app, and skips the check for an unsigned or development one", async () => {
    expect(
      await ownAppTeamId({
        ...packaged,
        readCommand: answer({ status: 0, stdout: "", stderr: "TeamIdentifier=ABCDE12345\n" }),
      }),
    ).toBe("ABCDE12345");
    expect(
      await ownAppTeamId({
        ...packaged,
        readCommand: answer({ status: 0, stdout: "", stderr: "TeamIdentifier=not set\n" }),
      }),
    ).toBeNull();
    expect(
      await ownAppTeamId({
        ...packaged,
        readCommand: answer({ status: 1, stdout: "", stderr: "code object is not signed at all" }),
      }),
    ).toBeNull();
    expect(await ownAppTeamId({ ...packaged, isPackaged: false })).toBeNull();
  });

  it("refuses rather than skips when a packaged app cannot read its own signature", async () => {
    expect(
      await ownAppTeamId({
        ...packaged,
        readCommand: answer({ status: 1, stdout: "", stderr: "codesign: timed out" }),
      }),
    ).toBe("unavailable");
    expect(await ownAppTeamId({ ...packaged, executable: "/usr/local/bin/ryco" })).toBe(
      "unavailable",
    );
  });
});
