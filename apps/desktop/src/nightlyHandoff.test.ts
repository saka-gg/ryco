import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  flavorAppExecutable,
  handoffLaunchEnv,
  type NightlyHandoffEnvironment,
  openNightly,
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
  const executable = Path.join(bundle, "Contents", "MacOS", name);
  FS.writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });
  return executable;
}

function setup(flavor: "stable" | "nightly", overrides: Partial<NightlyHandoffEnvironment> = {}) {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "ryco-nightly-handoff-"));
  roots.push(root);
  const applications = Path.join(root, "Applications");
  FS.mkdirSync(applications);
  const launched: Array<{ executable: string; env: NodeJS.ProcessEnv }> = [];
  const environment: NightlyHandoffEnvironment = {
    platform: "darwin",
    flavor,
    homeDirectory: root,
    rycoHome: Path.join(root, flavor === "stable" ? ".ryco" : ".ryco-nightly"),
    nightlyHome: Path.join(root, ".ryco-nightly"),
    executable: "/Applications/Ryco.app/Contents/MacOS/Ryco",
    env: {},
    applicationsDirectories: [applications],
    launch: (executable, env) => launched.push({ executable, env }),
    ...overrides,
  };
  return { root, applications, environment, launched };
}

describe("finding the other app", () => {
  it("opens a bundle only when its Info.plist names that app's bundle id", async () => {
    const { applications } = setup("stable");
    const nightly = writeApp(applications, "Ryco Nightly", "com.laurinfrank.ryco.nightly");
    expect(await flavorAppExecutable(Path.join(applications, "Ryco Nightly.app"), "nightly")).toBe(
      nightly,
    );
    expect(await flavorAppExecutable(Path.join(applications, "Ryco Nightly.app"), "stable")).toBe(
      null,
    );
    writeApp(applications, "Impostor", "com.example.other");
    expect(
      await flavorAppExecutable(Path.join(applications, "Impostor.app"), "nightly"),
    ).toBeNull();
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
  it("asks for a copy only in Ryco Nightly's home and starts it with a clean environment", async () => {
    const { applications, environment, launched, root } = setup("stable", {
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

    const request = JSON.parse(
      FS.readFileSync(Path.join(root, ".ryco-nightly", "import-requested.json"), "utf8"),
    );
    expect(request).toEqual({
      version: 1,
      requestedAt: "2026-10-31T08:00:00.000Z",
      sourceHomeDir: environment.rycoHome,
    });
    expect(FS.readdirSync(environment.rycoHome)).toEqual(stableBefore);
    expect(launched).toHaveLength(1);
    expect(launched[0]?.executable).toBe(nightly);
    expect(launched[0]?.env).toEqual({
      PATH: "/usr/bin",
      RYCO_NIGHTLY_HOME: "/kept/nightly-home",
      RYCO_STABLE_HOME: environment.rycoHome,
      RYCO_STABLE_EXECUTABLE: environment.executable,
    });
  });

  it("refuses to ask for a copy while Ryco Nightly's node runs", async () => {
    const { applications, environment, launched } = setup("stable");
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
    expect(FS.existsSync(Path.join(environment.nightlyHome, "import-requested.json"))).toBe(false);
    expect(launched).toEqual([]);
    // Opening it as it is still works.
    await openNightly(environment, { copyData: false });
    expect(launched).toHaveLength(1);
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
  it("opens Ryco, never with Nightly's home, and copies nothing back", async () => {
    const { applications, environment, launched } = setup("nightly");
    const stable = writeApp(applications, "Ryco", "com.laurinfrank.ryco");
    const switching = {
      ...environment,
      env: {
        PATH: "/usr/bin",
        RYCO_HOME: environment.nightlyHome,
        RYCO_STABLE_HOME: "/x",
        RYCO_STABLE_EXECUTABLE: "/not/an/app",
      },
    };
    await switchBackToRyco(switching);
    expect(launched).toEqual([{ executable: stable, env: { PATH: "/usr/bin" } }]);
    expect(FS.existsSync(environment.nightlyHome)).toBe(false);
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

describe("handoffLaunchEnv", () => {
  it("drops every Ryco variable but Nightly's own home, and Node-mode switches", () => {
    expect(
      handoffLaunchEnv(
        {
          HOME: "/h",
          RYCO_DESKTOP_CLI: "/h/.ryco",
          RYCO_NIGHTLY_HOME: "/n",
          ELECTRON_NO_ASAR: "1",
        },
        { RYCO_STABLE_HOME: "/h/.ryco" },
      ),
    ).toEqual({ HOME: "/h", RYCO_NIGHTLY_HOME: "/n", RYCO_STABLE_HOME: "/h/.ryco" });
  });
});
