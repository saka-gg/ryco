import { it } from "@effect/vitest";
import { RuntimeSessionId, ThreadId } from "@ryco/contracts";
import { Effect } from "effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { describe, expect } from "vite-plus/test";

import {
  type AgentProcessPriorityShape,
  makeAgentProcessPriority,
} from "../agentProcessPriority.ts";
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";

const linuxExecNice = makeAgentProcessPriority({
  enabled: Effect.succeed(true),
  platform: "linux",
  niceExecutable: () => "/usr/bin/nice",
  commandResolves: async () => true,
  lowerChild: () => "lowered",
});

/** Records the spawn, then refuses it, so the runtime stops right after the spawn attempt. */
function refusingSpawner() {
  const spawned: Array<ChildProcess.StandardCommand> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    spawned.push(command as ChildProcess.StandardCommand);
    return Effect.fail(
      PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "ChildProcess",
        method: "spawn",
        description: "test spawner refuses",
      }),
    );
  });
  return { spawner, spawned };
}

const startRuntime = (processPriority: AgentProcessPriorityShape | undefined) => {
  const { spawner, spawned } = refusingSpawner();
  return makeCodexSessionRuntime({
    threadId: ThreadId.make("thread-codex-priority"),
    runtimeSessionId: RuntimeSessionId.make("runtime-codex-priority"),
    binaryPath: "codex",
    homePath: "/tmp/codex-priority-home",
    cwd: "/tmp",
    runtimeMode: "full-access",
    tokenMode: "balanced",
    ...(processPriority ? { processPriority } : {}),
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.scoped,
    Effect.flip,
    Effect.map((error) => ({ error, spawned })),
  );
};

describe("makeCodexSessionRuntime agent priority", () => {
  it.effect("starts codex app-server through nice and keeps the configured command in errors", () =>
    Effect.gen(function* () {
      const { error, spawned } = yield* startRuntime(linuxExecNice);
      expect(error._tag).toBe("CodexAppServerSpawnError");
      expect((error as { readonly command?: string }).command).toBe("codex app-server");
      expect(spawned).toHaveLength(1);
      expect(spawned[0]!.command).toBe("/usr/bin/nice");
      expect(spawned[0]!.args).toEqual(["-n", "5", "codex", "app-server"]);
      expect(spawned[0]!.options.env?.CODEX_HOME).toBe("/tmp/codex-priority-home");
      expect(spawned[0]!.options.cwd).toBe("/tmp");
    }),
  );

  it.effect("spawns codex app-server unchanged without a priority", () =>
    Effect.gen(function* () {
      const { spawned } = yield* startRuntime(undefined);
      expect(spawned).toHaveLength(1);
      expect(spawned[0]!.command).toBe("codex");
      expect(spawned[0]!.args).toEqual(["app-server"]);
    }),
  );
});
