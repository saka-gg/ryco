/**
 * Runs Claude Code through `nice` via the Agent SDK's `spawnClaudeCodeProcess` hook.
 *
 * The hook is only used when it changes the argv (an "exec-nice" plan for a native binary);
 * everything else keeps the SDK's own spawn. The returned process mirrors the SDK's built-in
 * local spawn: it drains stderr into a bounded tail (an undrained pipe would block Claude Code
 * once 64 KiB fill it) and delivers `exit` only after stderr closed (bounded by a short grace),
 * so the tail is complete when the SDK raises. The SDK appends the tail to its exit errors only
 * for its own spawn ("Custom `spawnClaudeCodeProcess` implementations emit plain process exit"),
 * so the adapter restores it with {@link appendClaudeStderrTail}: user-visible errors, and the
 * resume-failure classifier that reads them, see the same text as with the SDK's spawn.
 *
 * @module provider/claudeCodeSpawn
 */
import {
  type ChildProcess,
  spawn as nodeSpawn,
  type SpawnOptions as NodeSpawnOptions,
} from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { redactDiagnosticText } from "@ryco/shared/diagnosticRedaction";
import { applyAgentLaunchPlan } from "@ryco/shared/processPriority";
import { Effect } from "effect";

import type { AgentProcessPriorityShape } from "./agentProcessPriority.ts";

/** The SDK runs these through node/bun instead of spawning them (its own extension list). */
const CLAUDE_JS_ENTRY = /\.(?:js|mjs|ts|tsx|jsx)$/;
/** The SDK's own stderr tail size. */
export const CLAUDE_STDERR_TAIL_CHARS = 2_048;
/** How long `exit` waits for stderr to close, as in the SDK's own spawn. */
const STDERR_DRAIN_GRACE_MS = 200;
const DRAINED_EXIT_EVENT = "ryco-exit-after-stderr-drained";

/** The SDK's exit errors, before it would have appended `. stderr: …`. */
const CLAUDE_PROCESS_EXIT_MESSAGE =
  /^Claude Code process (?:exited with code -?\d+|terminated by signal \S+)$/;

export interface ClaudeCodeSpawn {
  readonly spawnClaudeCodeProcess: (options: SpawnOptions) => SpawnedProcess;
  /** The redacted, trimmed stderr tail of the latest process started ("" before any output). */
  readonly stderrTail: () => string;
}

type SpawnChild = (command: string, args: Array<string>, options: NodeSpawnOptions) => ChildProcess;

const spawnChild: SpawnChild = (command, args, options) => nodeSpawn(command, args, options);

/**
 * A spawner that runs Claude Code through `nice`, or `undefined` to keep the SDK's own spawn
 * (no priority service, a JS entry point, or any plan other than "exec-nice": the setting is
 * off, Windows, no `nice`, an unresolvable binary, macOS DYLD_* variables).
 */
export const prepareClaudeCodeSpawn = (
  priority: AgentProcessPriorityShape | undefined,
  input: {
    readonly binaryPath: string;
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string | undefined;
  },
  spawnImpl: SpawnChild = spawnChild,
): Effect.Effect<ClaudeCodeSpawn | undefined> =>
  Effect.gen(function* () {
    if (priority === undefined || CLAUDE_JS_ENTRY.test(input.binaryPath)) return undefined;
    const plan = yield* priority.plan({
      command: input.binaryPath,
      env: input.env,
      cwd: input.cwd,
      shell: false,
    });
    if (plan.mode !== "exec-nice") return undefined;

    let tail = "";
    const spawnClaudeCodeProcess = (options: SpawnOptions): SpawnedProcess => {
      tail = "";
      // The SDK passes a native binary's path verbatim; anything else is spawned unchanged.
      const argv =
        options.command === input.binaryPath
          ? applyAgentLaunchPlan(plan, options.command, options.args)
          : { command: options.command, args: options.args };
      const child = spawnImpl(argv.command, [...argv.args], {
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      return wrapClaudeCodeProcess(child, (chunk) => {
        tail += chunk;
        if (tail.length > 2 * CLAUDE_STDERR_TAIL_CHARS) tail = lastChars(tail);
      });
    };
    return {
      spawnClaudeCodeProcess,
      stderrTail: () => redactDiagnosticText(lastChars(tail)).trim(),
    };
  });

/** The last {@link CLAUDE_STDERR_TAIL_CHARS} characters, never starting inside a surrogate pair. */
function lastChars(text: string): string {
  if (text.length <= CLAUDE_STDERR_TAIL_CHARS) return text;
  const tail = text.slice(-CLAUDE_STDERR_TAIL_CHARS);
  const first = tail.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
}

/** The SDK's `SpawnedProcess` over a child, with `exit` delivered after stderr drained. */
function wrapClaudeCodeProcess(
  child: ChildProcess,
  onStderr: (chunk: string) => void,
): SpawnedProcess {
  const decoder = new StringDecoder("utf8");
  let stderrClosed = false;
  let exited = false;
  let delivered = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const deliverExit = () => {
    if (delivered) return;
    delivered = true;
    if (grace !== undefined) clearTimeout(grace);
    child.emit(DRAINED_EXIT_EVENT, child.exitCode, child.signalCode);
    // A grandchild may still hold stderr open; do not let it keep the server alive.
    const stderr = child.stderr as (NodeJS.ReadableStream & { unref?: () => void }) | null;
    if (stderr && typeof stderr.unref === "function") stderr.unref();
    else child.stderr?.destroy();
  };
  child.stderr?.on("data", (chunk: Buffer) => {
    if (!delivered) onStderr(decoder.write(chunk));
  });
  child.stderr?.on("error", () => undefined);
  child.stderr?.once("close", () => {
    onStderr(decoder.end());
    stderrClosed = true;
    if (exited) deliverExit();
  });
  child.once("exit", () => {
    exited = true;
    if (stderrClosed) deliverExit();
    else grace = setTimeout(deliverExit, STDERR_DRAIN_GRACE_MS);
  });
  const eventName = (event: string) => (event === "exit" ? DRAINED_EXIT_EVENT : event);
  type Listener = Parameters<ChildProcess["on"]>[1];
  return {
    stdin: child.stdin!,
    stdout: child.stdout!,
    get killed() {
      return child.killed;
    },
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    kill: (signal: NodeJS.Signals) => child.kill(signal),
    on: (event: string, listener: Listener) => {
      child.on(eventName(event), listener);
    },
    once: (event: string, listener: Listener) => {
      child.once(eventName(event), listener);
    },
    off: (event: string, listener: Listener) => {
      child.off(eventName(event), listener);
    },
  } as SpawnedProcess;
}

/**
 * Restores the stderr tail on an SDK exit error from a {@link prepareClaudeCodeSpawn} process,
 * in the SDK's own format (`<message>. stderr: <tail>`). Mutates the error in place, because the
 * SDK rejects every pending request with the same error object; idempotent; any other value is
 * returned unchanged.
 */
export function appendClaudeStderrTail<A>(cause: A, tail: string): A {
  if (!(cause instanceof Error) || tail.length === 0) return cause;
  const original = cause.message;
  if (!CLAUDE_PROCESS_EXIT_MESSAGE.test(original)) return cause;
  cause.message = `${original}. stderr: ${tail}`;
  const header = `${cause.name}: ${original}`;
  if (typeof cause.stack === "string" && cause.stack.startsWith(header)) {
    cause.stack = `${cause.name}: ${cause.message}${cause.stack.slice(header.length)}`;
  }
  return cause;
}
