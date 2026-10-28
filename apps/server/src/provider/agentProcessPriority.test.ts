import os from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { ServerSettingsError } from "@ryco/contracts";
import { resolveNiceExecutable } from "@ryco/shared/processPriority";
import { Effect, Layer, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { describe, expect } from "vite-plus/test";

import { ServerSettingsService } from "../serverSettings.ts";
import {
  AgentProcessPriority,
  AgentProcessPriorityLive,
  type AgentProcessPriorityDeps,
  makeAgentProcessPriority,
  spawnAgentProcess,
} from "./agentProcessPriority.ts";

const expectedLoweredNice = () => Math.min(19, os.getPriority() + 5);

function makeFactsPriority(overrides: Partial<AgentProcessPriorityDeps> = {}) {
  const lowered: number[] = [];
  const resolved: string[] = [];
  const priority = makeAgentProcessPriority({
    enabled: Effect.succeed(true),
    platform: "linux",
    niceExecutable: () => "/usr/bin/nice",
    commandResolves: async (command) => {
      resolved.push(command);
      return true;
    },
    lowerChild: (pid) => {
      lowered.push(pid);
      return "lowered";
    },
    ...overrides,
  });
  return { priority, lowered, resolved };
}

/** Records every spawned command and answers with a handle whose pid is 4321. */
function recordingSpawner() {
  const spawned: Array<ChildProcess.StandardCommand> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    spawned.push(command as ChildProcess.StandardCommand);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(4321),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  return { spawner, spawned };
}

const serveCommand = (options: ChildProcess.CommandOptions = {}) =>
  ChildProcess.make("opencode", ["serve", "--port=1"], {
    cwd: "/tmp",
    env: { PATH: "/usr/bin:/bin", OPENCODE_CONFIG_CONTENT: "{}" },
    detached: true,
    shell: false,
    ...options,
  });

describe("spawnAgentProcess", () => {
  effectIt.effect("execs the agent through nice with the same options object", () =>
    Effect.gen(function* () {
      const { spawner, spawned } = recordingSpawner();
      const { priority, resolved, lowered } = makeFactsPriority();
      const command = serveCommand();
      yield* spawnAgentProcess(spawner, priority, command).pipe(Effect.scoped);
      expect(spawned).toHaveLength(1);
      expect(spawned[0]!.command).toBe("/usr/bin/nice");
      expect(spawned[0]!.args).toEqual(["-n", "5", "opencode", "serve", "--port=1"]);
      expect(spawned[0]!.options).toBe(command.options);
      expect(resolved).toEqual(["opencode"]);
      expect(lowered).toEqual([]);
    }),
  );

  effectIt.effect("spawns the original command when priority is absent", () =>
    Effect.gen(function* () {
      const { spawner, spawned } = recordingSpawner();
      const command = serveCommand();
      yield* spawnAgentProcess(spawner, undefined, command).pipe(Effect.scoped);
      expect(spawned).toEqual([command]);
    }),
  );

  effectIt.effect("spawns the original command when the setting is off", () =>
    Effect.gen(function* () {
      const { spawner, spawned } = recordingSpawner();
      const { priority, resolved, lowered } = makeFactsPriority({
        enabled: Effect.succeed(false),
      });
      const command = serveCommand();
      yield* spawnAgentProcess(spawner, priority, command).pipe(Effect.scoped);
      expect(spawned).toEqual([command]);
      expect(resolved).toEqual([]);
      expect(lowered).toEqual([]);
    }),
  );

  effectIt.effect("lowers a Windows agent after spawn without resolving it", () =>
    Effect.gen(function* () {
      const { spawner, spawned } = recordingSpawner();
      const { priority, resolved, lowered } = makeFactsPriority({ platform: "win32" });
      const command = serveCommand({ shell: true });
      yield* spawnAgentProcess(spawner, priority, command).pipe(Effect.scoped);
      expect(spawned).toEqual([command]);
      expect(resolved).toEqual([]);
      expect(lowered).toEqual([4321]);
    }),
  );

  effectIt.effect("lowers a shell launch after spawn", () =>
    Effect.gen(function* () {
      const { spawner, spawned } = recordingSpawner();
      const { priority, resolved, lowered } = makeFactsPriority();
      const command = serveCommand({ shell: true });
      yield* spawnAgentProcess(spawner, priority, command).pipe(Effect.scoped);
      expect(spawned).toEqual([command]);
      expect(resolved).toEqual([]);
      expect(lowered).toEqual([4321]);
    }),
  );

  effectIt.effect("keeps macOS DYLD_* environments by lowering after spawn", () =>
    Effect.gen(function* () {
      const { spawner, spawned } = recordingSpawner();
      const { priority, resolved, lowered } = makeFactsPriority({ platform: "darwin" });
      const command = serveCommand({ env: { PATH: "/usr/bin", DYLD_LIBRARY_PATH: "/opt/lib" } });
      yield* spawnAgentProcess(spawner, priority, command).pipe(Effect.scoped);
      expect(spawned).toEqual([command]);
      expect(resolved).toEqual([]);
      expect(lowered).toEqual([4321]);
    }),
  );

  effectIt.effect("does not wrap a command that does not resolve", () =>
    Effect.gen(function* () {
      const { spawner, spawned } = recordingSpawner();
      const { priority, lowered } = makeFactsPriority({ commandResolves: async () => false });
      const command = serveCommand();
      yield* spawnAgentProcess(spawner, priority, command).pipe(Effect.scoped);
      expect(spawned).toEqual([command]);
      expect(lowered).toEqual([4321]);
    }),
  );

  effectIt.effect("looks the command up in the child's merged environment", () =>
    Effect.gen(function* () {
      const { spawner } = recordingSpawner();
      const lookups: Array<NodeJS.ProcessEnv> = [];
      const { priority } = makeFactsPriority({
        commandResolves: async (_command, options) => {
          lookups.push(options.env);
          return true;
        },
      });
      yield* spawnAgentProcess(
        spawner,
        priority,
        serveCommand({ env: { PATH: "/custom/bin" }, extendEnv: true }),
      ).pipe(Effect.scoped);
      expect(lookups[0]?.PATH).toBe("/custom/bin");
      expect(lookups[0]?.HOME).toBe(process.env.HOME);
    }),
  );

  effectIt.effect("falls back to after-spawn and warns once without nice", () =>
    Effect.gen(function* () {
      const { spawner, spawned } = recordingSpawner();
      const { priority, resolved, lowered } = makeFactsPriority({ niceExecutable: () => null });
      const command = serveCommand();
      yield* spawnAgentProcess(spawner, priority, command).pipe(Effect.scoped);
      yield* spawnAgentProcess(spawner, priority, command).pipe(Effect.scoped);
      expect(spawned).toEqual([command, command]);
      expect(resolved).toEqual([]);
      expect(lowered).toEqual([4321, 4321]);
    }),
  );
});

describe("AgentProcessPriorityLive", () => {
  const liveLayer = AgentProcessPriorityLive.pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
  );

  effectIt.effect("reads the setting at every launch", () =>
    Effect.gen(function* () {
      const priority = yield* AgentProcessPriority;
      const settings = yield* ServerSettingsService;
      const request = {
        command: process.execPath,
        env: process.env,
        cwd: undefined,
        shell: false,
      };
      const first = yield* priority.plan(request);
      if (process.platform === "win32") {
        expect(first.mode).toBe("after-spawn");
      } else {
        expect(first.mode).toBe("exec-nice");
        expect(first.prefix.slice(1)).toEqual(["-n", "5"]);
      }
      yield* settings.updateSettings({ lowerAgentProcessPriority: false });
      expect((yield* priority.plan(request)).mode).toBe("off");
      yield* settings.updateSettings({ lowerAgentProcessPriority: true });
      expect((yield* priority.plan(request)).mode).not.toBe("off");
    }).pipe(Effect.provide(liveLayer)),
  );

  effectIt.effect("keeps the default (on) when the setting cannot be read", () =>
    Effect.gen(function* () {
      const priority = yield* AgentProcessPriority;
      const plan = yield* priority.plan({
        command: process.execPath,
        env: process.env,
        cwd: undefined,
        shell: false,
      });
      expect(plan.mode).not.toBe("off");
    }).pipe(
      Effect.provide(
        AgentProcessPriorityLive.pipe(
          Layer.provide(
            Layer.succeed(ServerSettingsService, {
              getSettings: Effect.fail(
                new ServerSettingsError({ settingsPath: "/tmp/settings.json", detail: "broken" }),
              ),
            } as unknown as ServerSettingsService["Service"]),
          ),
        ),
      ),
    ),
  );
});

/** Prints its own niceness, then a grandchild's (inherits from the agent, not the server). */
const PRINT_NICENESS_SCRIPT = [
  "const os = require('node:os');",
  "const { spawnSync } = require('node:child_process');",
  "console.log(os.getPriority());",
  "const child = spawnSync(process.execPath, ['-e', \"console.log(require('node:os').getPriority())\"], { encoding: 'utf8' });",
  "process.stdout.write(child.stdout);",
].join("\n");

const runPrintNiceness = (enabled: boolean) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const priority = makeAgentProcessPriority({
      enabled: Effect.succeed(enabled),
      platform: process.platform,
      niceExecutable: resolveNiceExecutable,
      commandResolves: async () => true,
      lowerChild: () => "unchanged",
    });
    const handle = yield* spawnAgentProcess(
      spawner,
      priority,
      ChildProcess.make(process.execPath, ["-e", PRINT_NICENESS_SCRIPT], { env: process.env }),
    );
    const output = yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (text, chunk) => text + chunk,
      ),
    );
    yield* handle.exitCode;
    return output
      .trim()
      .split("\n")
      .map((line) => Number(line.trim()));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe.skipIf(process.platform === "win32" || resolveNiceExecutable() === null)(
  "spawnAgentProcess (real processes)",
  () => {
    effectIt.effect("runs the agent and its descendants at the server's niceness + 5", () =>
      Effect.gen(function* () {
        const expected = expectedLoweredNice();
        expect(yield* runPrintNiceness(true)).toEqual([expected, expected]);
      }),
    );

    effectIt.effect("leaves the agent at the server's niceness when off", () =>
      Effect.gen(function* () {
        const server = os.getPriority();
        expect(yield* runPrintNiceness(false)).toEqual([server, server]);
      }),
    );
  },
);
