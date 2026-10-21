import { describe, expect, it } from "@effect/vitest";

import {
  type DetectedNodeInstallation,
  detectNodeInstallation,
  isNewerNodeRelease,
  nodeInstallCommand,
  type NodeInstallationProbe,
  nodeReleaseChannel,
  nodeUpdateAvailability,
  nodeUpdateCapability,
  nodeVerifyCommand,
  npmGlobalPrefix,
  sourceCheckoutRootCandidate,
} from "./installation.ts";

const probe = (overrides: Partial<NodeInstallationProbe>): NodeInstallationProbe => ({
  mode: "web",
  invokedScriptPath: null,
  resolvedScriptPath: null,
  platform: "darwin",
  serviceLabel: undefined,
  parentPid: 4242,
  temporaryDirectory: "/var/folders/xy/T",
  isRycoCheckout: () => false,
  ...overrides,
});

const at = (scriptPath: string, overrides: Partial<NodeInstallationProbe> = {}) =>
  detectNodeInstallation(
    probe({ invokedScriptPath: scriptPath, resolvedScriptPath: scriptPath, ...overrides }),
  );

const asLaunchdService = { serviceLabel: "space.ryco.node", parentPid: 1 } as const;

describe("node installation detection", () => {
  it("treats a desktop backend as the desktop app, whatever its script", () => {
    expect(
      at("/Applications/Ryco.app/Contents/Resources/app.asar.unpacked/server/bin.mjs", {
        mode: "desktop",
        ...asLaunchdService,
      }),
    ).toMatchObject({ kind: "desktop-app", service: null, entryScript: null });
  });

  it.each([
    ["Homebrew node", "/opt/homebrew/lib/node_modules/ryco-cli/dist/bin.mjs", "/opt/homebrew"],
    [
      "nvm",
      "/Users/me/.nvm/versions/node/v22.11.0/lib/node_modules/ryco-cli/dist/bin.mjs",
      "/Users/me/.nvm/versions/node/v22.11.0",
    ],
    ["system prefix", "/usr/local/lib/node_modules/ryco-cli/dist/bin.mjs", "/usr/local"],
  ])("finds an npm global install under %s with its prefix", (_label, scriptPath, prefix) => {
    expect(at(scriptPath)).toMatchObject({ kind: "npm-global", npmPrefix: prefix });
  });

  it("finds a Windows npm prefix without the lib folder", () => {
    expect(
      npmGlobalPrefix(
        "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\ryco-cli\\dist\\bin.mjs",
        "win32",
      ),
    ).toBe("C:\\Users\\me\\AppData\\Roaming\\npm");
    expect(
      npmGlobalPrefix("/opt/homebrew/node_modules/ryco-cli/dist/bin.mjs", "darwin"),
    ).toBeNull();
  });

  it("does not take a dependency inside another package for a global install", () => {
    expect(at("/srv/app/node_modules/tool/lib/node_modules/ryco-cli/dist/bin.mjs").kind).toBe(
      "unknown",
    );
    expect(at("/srv/app/node_modules/ryco-cli/dist/bin.mjs").kind).toBe("unknown");
  });

  it("finds bun and pnpm global installs", () => {
    expect(at("/Users/me/.bun/install/global/node_modules/ryco-cli/dist/bin.mjs").kind).toBe(
      "bun-global",
    );
    for (const scriptPath of [
      "/Users/me/Library/pnpm/global/5/node_modules/ryco-cli/dist/bin.mjs",
      "/home/me/.local/share/pnpm/global/5/node_modules/ryco-cli/dist/bin.mjs",
      "C:\\Users\\me\\AppData\\Local\\pnpm\\global\\5\\node_modules\\ryco-cli\\dist\\bin.mjs",
    ]) {
      expect(at(scriptPath).kind).toBe("pnpm-global");
    }
  });

  it("marks a pnpm service started from one release folder, not the package link", () => {
    const releaseFolder =
      "/Users/me/Library/pnpm/global/5/node_modules/.pnpm/ryco-cli@0.1.35/node_modules/ryco-cli/dist/bin.mjs";
    const link = "/Users/me/Library/pnpm/global/5/node_modules/ryco-cli/dist/bin.mjs";
    expect(at(releaseFolder, asLaunchdService)).toMatchObject({
      kind: "pnpm-global",
      pinnedRelease: true,
    });
    expect(
      detectNodeInstallation(
        probe({ invokedScriptPath: link, resolvedScriptPath: releaseFolder, ...asLaunchdService }),
      ),
    ).toMatchObject({ kind: "pnpm-global", pinnedRelease: false, entryScript: link });
  });

  it("finds npx, bunx and temporary installs ephemeral", () => {
    expect(at("/Users/me/.npm/_npx/0a1b/node_modules/ryco-cli/dist/bin.mjs").kind).toBe(
      "ephemeral",
    );
    expect(at("/Users/me/.bun/install/cache/ryco-cli@0.1.35/dist/bin.mjs").kind).toBe("ephemeral");
    expect(
      at("/var/folders/xy/T/bunx-501-ryco-cli@latest/node_modules/ryco-cli/dist/bin.mjs").kind,
    ).toBe("ephemeral");
  });

  it("finds a source checkout only when its root is a Ryco repository", () => {
    expect(sourceCheckoutRootCandidate("/Users/me/Code/ryco/apps/server/dist/bin.mjs")).toBe(
      "/Users/me/Code/ryco",
    );
    expect(sourceCheckoutRootCandidate("/Users/me/Code/ryco/apps/server/src/bin.ts")).toBe(
      "/Users/me/Code/ryco",
    );
    expect(sourceCheckoutRootCandidate("/Users/me/Code/ryco/apps/server/src/cli.ts")).toBeNull();
    const isRycoCheckout = (root: string) => root === "/Users/me/Code/ryco";
    expect(at("/Users/me/Code/ryco/apps/server/dist/bin.mjs", { isRycoCheckout }).kind).toBe(
      "source-checkout",
    );
    expect(at("/Users/me/Code/other/apps/server/dist/bin.mjs", { isRycoCheckout }).kind).toBe(
      "unknown",
    );
  });

  it("calls anything else, or a missing entry script, unknown", () => {
    expect(at("/opt/tools/ryco/bin.mjs").kind).toBe("unknown");
    expect(detectNodeInstallation(probe({})).kind).toBe("unknown");
  });

  it("names the service manager only for a labelled launchd job or systemd unit", () => {
    const npm = "/opt/homebrew/lib/node_modules/ryco-cli/dist/bin.mjs";
    expect(at(npm, asLaunchdService)).toMatchObject({
      service: "launchd",
      serviceLabel: "space.ryco.node",
    });
    // An inherited label in a process launchd did not start is a foreground node.
    expect(at(npm, { serviceLabel: "space.ryco.node", parentPid: 777 }).service).toBeNull();
    expect(at(npm).service).toBeNull();
    expect(
      at("/usr/lib/node_modules/ryco-cli/dist/bin.mjs", {
        platform: "linux",
        serviceLabel: "space.ryco.node.1a2b3c4d",
        parentPid: 900,
      }),
    ).toMatchObject({
      kind: "npm-global",
      service: "systemd",
      serviceLabel: "space.ryco.node.1a2b3c4d",
    });
    expect(
      at("C:\\npm\\node_modules\\ryco-cli\\dist\\bin.mjs", {
        platform: "win32",
        serviceLabel: "space.ryco.node",
      }).service,
    ).toBeNull();
  });
});

const installed = (overrides: Partial<DetectedNodeInstallation>): DetectedNodeInstallation => ({
  kind: "npm-global",
  service: "launchd",
  serviceLabel: "space.ryco.node",
  npmPrefix: "/opt/homebrew",
  entryScript: "/opt/homebrew/lib/node_modules/ryco-cli/dist/bin.mjs",
  pinnedRelease: false,
  ...overrides,
});

const capability = (
  installation: DetectedNodeInstallation,
  overrides: Partial<Parameters<typeof nodeUpdateCapability>[0]> = {},
) =>
  nodeUpdateCapability({
    installation,
    platform: "darwin",
    channel: "latest",
    desktop: null,
    ...overrides,
  });

describe("node update capability", () => {
  it("lets service installs from npm, bun and pnpm update themselves", () => {
    for (const kind of ["npm-global", "bun-global", "pnpm-global"] as const) {
      expect(capability(installed({ kind }))).toEqual({
        canUpdate: true,
        manualReason: null,
        manualCommand: null,
      });
    }
  });

  it("gives a foreground global install the command and asks for a restart", () => {
    const foreground = { service: null, serviceLabel: null };
    expect(capability(installed(foreground))).toMatchObject({
      canUpdate: false,
      manualCommand: "npm install -g ryco-cli@latest",
    });
    expect(capability(installed(foreground)).manualReason).toContain("then restart ryco");
    expect(capability(installed({ ...foreground, kind: "bun-global" })).manualCommand).toBe(
      "bun add -g ryco-cli@latest",
    );
    expect(
      capability(installed({ ...foreground, kind: "pnpm-global" }), { channel: "nightly" })
        .manualCommand,
    ).toBe("pnpm add -g ryco-cli@nightly");
  });

  it("refuses Windows and a pnpm service pinned to one release, with the command", () => {
    expect(capability(installed({}), { platform: "win32" })).toMatchObject({
      canUpdate: false,
      manualCommand: "npm install -g ryco-cli@latest",
    });
    expect(capability(installed({ kind: "pnpm-global", pinnedRelease: true }))).toMatchObject({
      canUpdate: false,
      manualCommand: "pnpm add -g ryco-cli@latest",
    });
  });

  it("points other installations at what to run instead", () => {
    expect(capability(installed({ kind: "source-checkout" }))).toMatchObject({
      canUpdate: false,
      manualCommand: "bun run node:update",
    });
    expect(capability(installed({ kind: "ephemeral" }))).toMatchObject({
      canUpdate: false,
      manualCommand: "npx ryco-cli@latest",
    });
    const unknown = capability(installed({ kind: "unknown" }));
    expect(unknown).toMatchObject({ canUpdate: false, manualCommand: null });
    expect(unknown.manualReason).toBeTruthy();
  });

  it("lets a desktop app update once its updater reported and is on", () => {
    const desktop = installed({ kind: "desktop-app", service: null, serviceLabel: null });
    expect(capability(desktop)).toMatchObject({ canUpdate: false, manualCommand: null });
    expect(capability(desktop, { desktop: { enabled: false } }).canUpdate).toBe(false);
    expect(capability(desktop, { desktop: { enabled: true } }).canUpdate).toBe(true);
  });
});

describe("node release channel and versions", () => {
  it("tracks nightly for nightly builds and latest otherwise", () => {
    expect(nodeReleaseChannel("0.1.36-nightly.20261021.12")).toBe("nightly");
    expect(nodeReleaseChannel("0.1.36")).toBe("latest");
    expect(nodeReleaseChannel("0.1.36-beta.1")).toBe("latest");
  });

  it("is behind only on an older release, prereleases included", () => {
    expect(nodeUpdateAvailability("0.1.35", "0.1.36")).toBe("behind_latest");
    expect(nodeUpdateAvailability("0.1.36", "0.1.36")).toBe("current");
    expect(nodeUpdateAvailability("0.1.37", "0.1.36")).toBe("current");
    expect(nodeUpdateAvailability("0.1.36-nightly.20261020.3", "0.1.36-nightly.20261021.1")).toBe(
      "behind_latest",
    );
    expect(nodeUpdateAvailability("0.1.36-nightly.20261022.1", "0.1.36-nightly.20261021.9")).toBe(
      "current",
    );
    expect(nodeUpdateAvailability("0.1.36-nightly.20261021.1", "0.1.36")).toBe("behind_latest");
    expect(nodeUpdateAvailability("0.1.35", null)).toBe("unknown");
    expect(nodeUpdateAvailability("dev", "0.1.36")).toBe("unknown");
    expect(isNewerNodeRelease("0.1.36", "0.1.36")).toBe(false);
    expect(isNewerNodeRelease("0.1.36", "0.1.35")).toBe(true);
  });
});

describe("node install commands", () => {
  it("installs the exact release into the same installation", () => {
    expect(nodeInstallCommand(installed({}), "0.1.36", "/opt/homebrew/bin/node")).toMatchObject({
      command: "npm",
      args: ["install", "-g", "--prefix", "/opt/homebrew", "ryco-cli@0.1.36"],
    });
    expect(
      nodeInstallCommand(installed({ kind: "bun-global" }), "0.1.36", "/Users/me/.bun/bin/bun"),
    ).toMatchObject({ command: "/Users/me/.bun/bin/bun", args: ["add", "-g", "ryco-cli@0.1.36"] });
    expect(
      nodeInstallCommand(installed({ kind: "bun-global" }), "0.1.36", "/opt/homebrew/bin/node"),
    ).toMatchObject({ command: "bun" });
    expect(nodeInstallCommand(installed({ kind: "pnpm-global" }), "0.1.36", "node")).toMatchObject({
      command: "pnpm",
      args: ["add", "-g", "ryco-cli@0.1.36"],
    });
    expect(nodeInstallCommand(installed({ kind: "source-checkout" }), "0.1.36", "node")).toBeNull();
  });

  it("checks the release with the runtime and entry script the service starts", () => {
    expect(nodeVerifyCommand(installed({}), "/opt/homebrew/bin/node")).toMatchObject({
      command: "/opt/homebrew/bin/node",
      args: ["/opt/homebrew/lib/node_modules/ryco-cli/dist/bin.mjs", "--version"],
    });
  });
});
