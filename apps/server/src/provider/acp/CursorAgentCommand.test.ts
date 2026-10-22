import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { vi } from "vitest";

import {
  cursorAgentCommandCandidates,
  resolveCursorAgentCommand,
  resolveCursorMaintenanceCapabilities,
} from "./CursorAgentCommand.ts";

// Probes and session spawns must not search PATH synchronously: a stalled mount on PATH would
// block the event loop.
vi.mock("@ryco/shared/shell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ryco/shared/shell")>()),
  resolveCommandPath: () => {
    throw new Error("synchronous PATH search");
  },
}));

const makeBinDir = (commands: ReadonlyArray<string>) => {
  const binDir = path.join(os.tmpdir(), `ryco-cursor-command-${crypto.randomUUID()}`);
  mkdirSync(binDir, { recursive: true });
  for (const command of commands) {
    const file = path.join(binDir, command);
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o755);
  }
  return binDir;
};

describe("resolveCursorAgentCommand", () => {
  it.effect("prefers cursor-agent over the generic default agent when both are on PATH", () =>
    Effect.gen(function* () {
      const binDir = makeBinDir(["agent", "cursor-agent"]);
      const resolved = yield* resolveCursorAgentCommand("agent", { PATH: binDir });
      expect(resolved).toEqual({
        command: "cursor-agent",
        resolvedPath: path.join(binDir, "cursor-agent"),
      });
    }),
  );

  it.effect("keeps the default agent when cursor-agent is not installed", () =>
    Effect.gen(function* () {
      const binDir = makeBinDir(["agent"]);
      const resolved = yield* resolveCursorAgentCommand("", { PATH: binDir }, { fresh: true });
      expect(resolved).toEqual({ command: "agent", resolvedPath: path.join(binDir, "agent") });
    }),
  );

  it.effect("never rewrites an explicit binary path", () =>
    Effect.gen(function* () {
      const binDir = makeBinDir(["agent", "cursor-agent", "my-cursor"]);
      const resolved = yield* resolveCursorAgentCommand("my-cursor", { PATH: binDir });
      expect(resolved.command).toBe("my-cursor");
      expect(cursorAgentCommandCandidates("my-cursor")).toEqual(["my-cursor"]);
      expect(cursorAgentCommandCandidates("agent")).toEqual(["cursor-agent", "agent"]);
    }),
  );

  it.effect("re-resolves on fresh lookups so a newly installed cursor-agent is picked up", () =>
    Effect.gen(function* () {
      const binDir = makeBinDir(["agent"]);
      const env = { PATH: binDir };
      expect((yield* resolveCursorAgentCommand("agent", env, { fresh: true })).command).toBe(
        "agent",
      );
      const installed = path.join(binDir, "cursor-agent");
      writeFileSync(installed, "#!/bin/sh\n");
      chmodSync(installed, 0o755);
      expect((yield* resolveCursorAgentCommand("agent", env)).command).toBe("agent");
      expect((yield* resolveCursorAgentCommand("agent", env, { fresh: true })).command).toBe(
        "cursor-agent",
      );
    }),
  );
});

describe("resolveCursorMaintenanceCapabilities", () => {
  const spawnerReportingPrefix = (prefix: string, calls: Array<string>) =>
    ChildProcessSpawner.make((command) => {
      const { command: executable, args } = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      calls.push([executable, ...args].join(" "));
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.encodeText(Stream.make(`${prefix}\n`)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    });

  it.effect.skipIf(process.platform === "win32")(
    "upgrades the cursor-cli cask with brew and keeps self-update for other installs",
    () =>
      Effect.gen(function* () {
        const prefix = path.join(
          realpathSync(os.tmpdir()),
          `ryco-cursor-cask-${crypto.randomUUID()}`,
        );
        const brewPath = path.join(prefix, "bin", "brew");
        const caskBinary = path.join(
          prefix,
          "Caskroom",
          "cursor-cli",
          "2025.10.02",
          "cursor-agent",
        );
        for (const file of [brewPath, caskBinary]) {
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, "#!/bin/sh\n");
          chmodSync(file, 0o755);
        }
        const calls: Array<string> = [];
        const resolve = (resolvedPath: string) =>
          resolveCursorMaintenanceCapabilities({ command: "cursor-agent", resolvedPath }, {}).pipe(
            Effect.provideService(
              ChildProcessSpawner.ChildProcessSpawner,
              spawnerReportingPrefix(prefix, calls),
            ),
            Effect.provide(NodeServices.layer),
          );

        const cask = yield* resolve(caskBinary);
        expect(cask.update).toEqual({
          command: "brew upgrade --cask cursor-cli",
          executable: brewPath,
          args: ["upgrade", "--cask", "cursor-cli"],
          lockKey: "homebrew",
        });
        // Cursor's date-stamped versions are never compared, from brew or anywhere else.
        expect(cask.latestVersion).toBeNull();
        expect(cask.lookupLatestVersion).toBeUndefined();
        expect(calls).toEqual([`${brewPath} --prefix`]);

        const binDir = makeBinDir(["cursor-agent"]);
        const native = yield* resolve(path.join(binDir, "cursor-agent"));
        expect(native.update).toMatchObject({
          executable: path.join(binDir, "cursor-agent"),
          args: ["update"],
          lockKey: "cursor-agent",
        });
      }),
  );
});
