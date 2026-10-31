import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { ChildProcessSpawner } from "effect/process";

import {
  BUN_GLOBAL_INSTALL_LOCK_KEY,
  npmGlobalInstallLockKey,
  PNPM_GLOBAL_INSTALL_LOCK_KEY,
} from "../provider/installLockKeys.ts";
import { type DetectedNodeInstallation, nodeInstallLockKey } from "./installation.ts";
import {
  commandOutputTail,
  describeCommandFailure,
  makeNodeUpdateCommandRunner,
  NODE_UPDATE_OUTPUT_MAX_CHARS,
  nodeInstallCommand,
  nodeInstallHoldBack,
  nodePreflightCommand,
  nodeVerifyCommand,
  outputReportsVersion,
  recordNodeUpdateCommand,
  serviceRestartCommand,
} from "./processes.ts";

const result = (overrides: Partial<Parameters<typeof commandOutputTail>[0]> = {}) => ({
  exitCode: 1,
  timedOut: false,
  spawnError: null,
  stdout: "",
  stderr: "",
  ...overrides,
});

describe("node update processes", () => {
  it("restarts through launchctl kickstart or a non-blocking systemctl restart", () => {
    expect(serviceRestartCommand({ manager: "launchd", label: "space.ryco.node" }, 501)).toEqual({
      command: "launchctl",
      args: ["kickstart", "-k", "gui/501/space.ryco.node"],
    });
    expect(
      serviceRestartCommand({ manager: "systemd", label: "space.ryco.node.1a2b3c4d" }, 1000),
    ).toEqual({
      command: "systemctl",
      args: ["--user", "--no-block", "restart", "ryco-node-1a2b3c4d.service"],
    });
  });

  it("reads the release from `ryco --version` output", () => {
    expect(outputReportsVersion("ryco v0.1.36\n", "0.1.36")).toBe(true);
    expect(outputReportsVersion("\u001b[1mryco\u001b[0m 0.1.36", "0.1.36")).toBe(true);
    expect(outputReportsVersion("ryco v0.1.36-nightly.20261021.1", "0.1.36")).toBe(false);
    expect(outputReportsVersion("", "0.1.36")).toBe(false);
  });

  it("keeps the end of long output and names what failed", () => {
    const long = `${"x".repeat(NODE_UPDATE_OUTPUT_MAX_CHARS)}END`;
    const tail = commandOutputTail(result({ stderr: long }));
    expect(tail).toHaveLength(NODE_UPDATE_OUTPUT_MAX_CHARS);
    expect(tail?.endsWith("END")).toBe(true);
    expect(commandOutputTail(result())).toBeNull();
    const npm = { command: "/usr/bin/npm", args: [], timeout: 1 };
    expect(describeCommandFailure(npm, result({ timedOut: true }), "installing 0.1.36")).toBe(
      "npm timed out while installing 0.1.36.",
    );
    expect(describeCommandFailure(npm, result({ spawnError: "ENOENT" }), "installing 0.1.36")).toBe(
      "Could not run npm while installing 0.1.36.",
    );
  });

  it.live("runs a command and reports its exit, output, timeout and spawn failures", () =>
    Effect.gen(function* () {
      const run = makeNodeUpdateCommandRunner(yield* ChildProcessSpawner.ChildProcessSpawner);
      const node = process.execPath;
      const printed = yield* run({
        command: node,
        args: ["-e", "console.log('ryco v9.9.9'); console.error('warn'); process.exit(3)"],
        timeout: "20 seconds",
      });
      expect(printed).toMatchObject({ exitCode: 3, timedOut: false, spawnError: null });
      expect(printed.stdout.trim()).toBe("ryco v9.9.9");
      expect(printed.stderr.trim()).toBe("warn");

      const slow = yield* run({
        command: node,
        args: ["-e", "setTimeout(() => {}, 30000)"],
        timeout: "200 millis",
      });
      expect(slow).toMatchObject({ exitCode: null, timedOut: true });

      const missing = yield* run({
        command: "ryco-node-update-test-missing-command",
        args: [],
        timeout: "5 seconds",
      });
      expect(missing.exitCode).toBeNull();
      expect(missing.spawnError).not.toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("hands an installer's pid to its install lock, and stops one the lock refuses", () =>
    Effect.gen(function* () {
      const run = makeNodeUpdateCommandRunner(yield* ChildProcessSpawner.ChildProcessSpawner);
      const pids: Array<number> = [];
      const recorded = yield* run(
        { command: process.execPath, args: ["-e", "process.exit(0)"], timeout: "20 seconds" },
        (pid) => Effect.sync(() => void pids.push(pid)),
      );
      expect(recorded.exitCode).toBe(0);
      expect(pids).toHaveLength(1);
      expect(pids[0]).toBeGreaterThan(0);

      const refused = yield* run(
        {
          command: process.execPath,
          args: ["-e", "setTimeout(() => {}, 30000)"],
          timeout: "20 seconds",
        },
        () => Effect.fail(new Error("Another process took over this CLI's install lock.")),
      );
      expect(refused).toMatchObject({
        exitCode: null,
        timedOut: false,
        spawnError: "Another process took over this CLI's install lock.",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
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

  it("holds back brand-new dependency releases in an unattended install", () => {
    const nowMs = Date.parse("2026-10-31T12:00:00.000Z");
    const holdBack = nodeInstallHoldBack(nowMs, "48 hours");
    expect(holdBack).toEqual({
      publishedBeforeMs: Date.parse("2026-10-29T12:00:00.000Z"),
      minimumReleaseAgeMinutes: 2880,
    });
    expect(
      nodeInstallCommand(installed({}), "0.1.36", "/opt/homebrew/bin/node", holdBack),
    ).toMatchObject({
      command: "npm",
      args: [
        "install",
        "-g",
        "--prefix",
        "/opt/homebrew",
        "--before=2026-10-29T12:00:00.000Z",
        "ryco-cli@0.1.36",
      ],
    });
    expect(
      nodeInstallCommand(installed({ kind: "pnpm-global" }), "0.1.36", "node", holdBack),
    ).toMatchObject({
      command: "pnpm",
      args: ["add", "-g", "--config.minimumReleaseAge=2880", "ryco-cli@0.1.36"],
    });
    // bun installs without holding anything back.
    expect(
      nodeInstallCommand(installed({ kind: "bun-global" }), "0.1.36", "bun", holdBack),
    ).toBeNull();
  });

  it("takes the install lock key a provider CLI update into the same install takes", () => {
    expect(nodeInstallLockKey(installed({ npmPrefix: "C:\\Users\\Me\\npm" }))).toBe(
      npmGlobalInstallLockKey("C:\\Users\\Me\\npm"),
    );
    expect(npmGlobalInstallLockKey("C:\\Users\\Me\\npm")).toBe("npm-global:c:/users/me/npm");
    expect(nodeInstallLockKey(installed({ kind: "bun-global", npmPrefix: null }))).toBe(
      BUN_GLOBAL_INSTALL_LOCK_KEY,
    );
    expect(nodeInstallLockKey(installed({ kind: "pnpm-global", npmPrefix: null }))).toBe(
      PNPM_GLOBAL_INSTALL_LOCK_KEY,
    );
    expect(nodeInstallLockKey(installed({ kind: "source-checkout" }))).toBeNull();
    expect(nodeInstallLockKey(installed({ npmPrefix: null }))).toBeNull();
  });

  it("checks the release with the runtime and entry script the service starts", () => {
    expect(nodeVerifyCommand(installed({}), "/opt/homebrew/bin/node")).toMatchObject({
      command: "/opt/homebrew/bin/node",
      args: ["/opt/homebrew/lib/node_modules/ryco-cli/dist/bin.mjs", "--version"],
    });
    expect(
      nodePreflightCommand(installed({}), "/opt/homebrew/bin/node", "/tmp/copy.sqlite"),
    ).toMatchObject({
      command: "/opt/homebrew/bin/node",
      args: [
        "/opt/homebrew/lib/node_modules/ryco-cli/dist/bin.mjs",
        "node-update-preflight",
        "--database",
        "/tmp/copy.sqlite",
      ],
    });
    expect(nodePreflightCommand(installed({ entryScript: null }), "node", "/tmp/x")).toBeNull();
  });

  it("records a command for the boot guard with its timeout in milliseconds", () => {
    const install = nodeInstallCommand(installed({}), "0.1.35", "/opt/homebrew/bin/node")!;
    expect(recordNodeUpdateCommand(install)).toEqual({
      command: "npm",
      args: ["install", "-g", "--prefix", "/opt/homebrew", "ryco-cli@0.1.35"],
      timeoutMs: 600_000,
    });
  });
});
