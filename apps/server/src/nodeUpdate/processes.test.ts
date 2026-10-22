import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { ChildProcessSpawner } from "effect/process";

import {
  commandOutputTail,
  describeCommandFailure,
  makeNodeUpdateCommandRunner,
  NODE_UPDATE_OUTPUT_MAX_CHARS,
  outputReportsVersion,
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
});
