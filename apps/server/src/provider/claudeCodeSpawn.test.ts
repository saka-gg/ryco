import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import {
  query as runClaudeSdkQuery,
  type SDKUserMessage,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { it as effectIt } from "@effect/vitest";
import { agentCommandResolves, resolveNiceExecutable } from "@ryco/shared/processPriority";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  AgentProcessPriorityOff,
  type AgentProcessPriorityShape,
  makeAgentProcessPriority,
} from "./agentProcessPriority.ts";
import {
  appendClaudeStderrTail,
  CLAUDE_STDERR_TAIL_CHARS,
  prepareClaudeCodeSpawn,
} from "./claudeCodeSpawn.ts";
import { isMissingConversationError } from "./resumeFailure.ts";

const LINUX_EXEC_NICE: AgentProcessPriorityShape = makeAgentProcessPriority({
  enabled: Effect.succeed(true),
  platform: "linux",
  niceExecutable: () => "/usr/bin/nice",
  commandResolves: async () => true,
  lowerChild: () => "lowered",
});

/** Agent priority with this machine's real facts (what the server uses). */
const realPriority = (enabled = true): AgentProcessPriorityShape =>
  makeAgentProcessPriority({
    enabled: Effect.succeed(enabled),
    platform: process.platform,
    niceExecutable: resolveNiceExecutable,
    commandResolves: agentCommandResolves,
    lowerChild: () => "unchanged",
  });

const sdkSpawnOptions = (command: string, args: Array<string>): SpawnOptions => ({
  command,
  args,
  cwd: "/tmp",
  env: { PATH: "/usr/bin:/bin" },
  signal: new AbortController().signal,
});

/** Records the spawn and returns an inert child. */
function recordingSpawnImpl() {
  const calls: Array<{ command: string; args: Array<string>; options: Record<string, unknown> }> =
    [];
  const spawnImpl = (command: string, args: Array<string>, options: object) => {
    calls.push({ command, args, options: options as Record<string, unknown> });
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      killed: false,
      exitCode: null,
      signalCode: null,
      kill: () => true,
    });
    return child as unknown as import("node:child_process").ChildProcess;
  };
  return { calls, spawnImpl };
}

describe("prepareClaudeCodeSpawn", () => {
  effectIt.effect("keeps the SDK's own spawn unless the argv changes", () =>
    Effect.gen(function* () {
      const input = { binaryPath: "/opt/claude/bin/claude", env: process.env, cwd: undefined };
      expect(yield* prepareClaudeCodeSpawn(undefined, input)).toBeUndefined();
      expect(yield* prepareClaudeCodeSpawn(AgentProcessPriorityOff, input)).toBeUndefined();
      const afterSpawn = makeAgentProcessPriority({
        enabled: Effect.succeed(true),
        platform: "win32",
        niceExecutable: () => null,
        commandResolves: async () => true,
        lowerChild: () => "lowered",
      });
      expect(yield* prepareClaudeCodeSpawn(afterSpawn, input)).toBeUndefined();
      expect(
        yield* prepareClaudeCodeSpawn(LINUX_EXEC_NICE, {
          ...input,
          binaryPath: "/opt/claude/cli.js",
        }),
      ).toBeUndefined();
    }),
  );

  effectIt.effect("spawns the native binary through nice like the SDK's own spawn", () =>
    Effect.gen(function* () {
      const { calls, spawnImpl } = recordingSpawnImpl();
      const spawn = yield* prepareClaudeCodeSpawn(
        LINUX_EXEC_NICE,
        { binaryPath: "claude", env: process.env, cwd: "/tmp" },
        spawnImpl,
      );
      expect(spawn).toBeDefined();
      const options = sdkSpawnOptions("claude", ["--output-format", "stream-json"]);
      spawn!.spawnClaudeCodeProcess(options);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.command).toBe("/usr/bin/nice");
      expect(calls[0]!.args).toEqual(["-n", "5", "claude", "--output-format", "stream-json"]);
      expect(calls[0]!.options).toEqual({
        cwd: "/tmp",
        env: options.env,
        signal: options.signal,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      expect(calls[0]!.options).not.toHaveProperty("detached");

      spawn!.spawnClaudeCodeProcess(sdkSpawnOptions("node", ["/opt/claude/cli.js"]));
      expect(calls[1]!.command).toBe("node");
      expect(calls[1]!.args).toEqual(["/opt/claude/cli.js"]);
    }),
  );
});

describe("appendClaudeStderrTail", () => {
  it("restores the SDK's stderr suffix on its exit errors, once", () => {
    const exited = new Error("Claude Code process exited with code 1");
    expect(appendClaudeStderrTail(exited, "boom").message).toBe(
      "Claude Code process exited with code 1. stderr: boom",
    );
    expect(appendClaudeStderrTail(exited, "boom").message).toBe(
      "Claude Code process exited with code 1. stderr: boom",
    );
    expect(
      exited.stack?.startsWith("Error: Claude Code process exited with code 1. stderr: boom"),
    ).toBe(true);
    const signalled = new Error("Claude Code process terminated by signal SIGKILL");
    expect(appendClaudeStderrTail(signalled, "oom").message).toBe(
      "Claude Code process terminated by signal SIGKILL. stderr: oom",
    );
  });

  it("leaves other errors, empty tails and non-errors alone", () => {
    expect(appendClaudeStderrTail(new Error("Request was aborted"), "x").message).toBe(
      "Request was aborted",
    );
    expect(
      appendClaudeStderrTail(new Error("Claude Code process exited with code 1"), "").message,
    ).toBe("Claude Code process exited with code 1");
    expect(appendClaudeStderrTail("Claude Code process exited with code 1", "x")).toBe(
      "Claude Code process exited with code 1",
    );
  });
});

const realProcesses = process.platform !== "win32" && resolveNiceExecutable() !== null;

describe.skipIf(!realProcesses)("prepareClaudeCodeSpawn (real processes)", () => {
  it("runs Claude Code at the server's niceness + 5 and never blocks on a full stderr pipe", async () => {
    const spawn = await Effect.runPromise(
      prepareClaudeCodeSpawn(realPriority(), {
        binaryPath: process.execPath,
        env: process.env,
        cwd: undefined,
      }),
    );
    expect(spawn).toBeDefined();
    const child = spawn!.spawnClaudeCodeProcess({
      command: process.execPath,
      args: [
        "-e",
        "process.stderr.write('x'.repeat(300000)); console.log(require('node:os').getPriority()); process.exit(3)",
      ],
      env: { ...process.env },
      signal: new AbortController().signal,
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    const exit = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Claude Code did not exit")), 10_000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    expect(exit).toBe(3);
    expect(Number(stdout.trim())).toBe(Math.min(19, os.getPriority() + 5));
    const tail = spawn!.stderrTail();
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.length).toBeLessThanOrEqual(CLAUDE_STDERR_TAIL_CHARS);
    expect(/^x+$/.test(tail)).toBe(true);
  });

  describe("SDK exit errors", () => {
    let root = "";
    let fakeClaude = "";
    beforeAll(() => {
      root = mkdtempSync(path.join(os.tmpdir(), "ryco-claude-spawn-"));
      fakeClaude = path.join(root, "claude");
      writeFileSync(
        fakeClaude,
        "#!/bin/sh\necho 'No conversation found with session ID: x' >&2\nexit 1\n",
      );
      chmodSync(fakeClaude, 0o755);
    });
    afterAll(() => {
      if (root) rmSync(root, { recursive: true, force: true });
    });

    /** The message `initializationResult()` rejects with, as the adapter's initialize error reads it. */
    const initializeFailure = async (priority: AgentProcessPriorityShape | undefined) => {
      const spawn = await Effect.runPromise(
        prepareClaudeCodeSpawn(priority, { binaryPath: fakeClaude, env: process.env, cwd: root }),
      );
      const abortController = new AbortController();
      const sdkQuery = runClaudeSdkQuery({
        // oxlint-disable-next-line require-yield
        prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
          await new Promise<never>(() => undefined);
        })(),
        options: {
          cwd: root,
          pathToClaudeCodeExecutable: fakeClaude,
          env: { ...process.env },
          abortController,
          ...(spawn ? { spawnClaudeCodeProcess: spawn.spawnClaudeCodeProcess } : {}),
        },
      });
      void sdkQuery.next().catch(() => undefined);
      try {
        await sdkQuery.initializationResult();
        throw new Error("initialize unexpectedly succeeded");
      } catch (cause) {
        return { cause, spawn };
      } finally {
        abortController.abort();
      }
    };

    it("carry the same stderr reason as the SDK's own spawn", async () => {
      const sdkDefault = await initializeFailure(undefined);
      expect(sdkDefault.spawn).toBeUndefined();
      expect((sdkDefault.cause as Error).message).toBe(
        "Claude Code process exited with code 1. stderr: No conversation found with session ID: x",
      );

      const lowered = await initializeFailure(realPriority());
      expect(lowered.spawn).toBeDefined();
      // The SDK drops the tail for custom spawners; the adapter restores it.
      expect((lowered.cause as Error).message).toBe("Claude Code process exited with code 1");
      const restored = appendClaudeStderrTail(lowered.cause, lowered.spawn!.stderrTail());
      expect((restored as Error).message).toBe((sdkDefault.cause as Error).message);
      expect(isMissingConversationError(restored)).toBe(true);
    });
  });
});
