/**
 * Keep the machine from idle-sleeping while this node runs. A sleeping Mac
 * drops every relay, LAN, and Tailscale connection and misses remote work, so a
 * node meant to be reachable holds an assertion for exactly its own lifetime.
 */
import { spawn, type ChildProcess } from "node:child_process";

import { Effect, Layer } from "effect";

import { ServerConfig } from "../config.ts";

export interface SleepInhibitorCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly description: string;
}

/**
 * The OS tool that holds the assertion, tied to `pid` so it ends even if this
 * process is killed without running its shutdown path.
 *
 * macOS `caffeinate -s` blocks system sleep only while on AC power, so a laptop
 * on battery still sleeps normally; the display may sleep either way.
 */
export function sleepInhibitorCommand(
  platform: NodeJS.Platform,
  pid: number,
): SleepInhibitorCommand | null {
  if (platform === "darwin") {
    return {
      command: "caffeinate",
      args: ["-s", "-w", String(pid)],
      description: "caffeinate (system sleep blocked while on AC power)",
    };
  }
  if (platform === "linux") {
    return {
      command: "systemd-inhibit",
      args: [
        "--what=sleep:idle",
        "--who=Ryco",
        "--why=Keeping this Ryco node reachable",
        "--mode=block",
        "tail",
        `--pid=${pid}`,
        "-f",
        "/dev/null",
      ],
      description: "systemd-inhibit (sleep and idle blocked)",
    };
  }
  return null;
}

export const SleepInhibitorLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (!config.preventSleep) return;
    const command = sleepInhibitorCommand(process.platform, process.pid);
    if (command === null) {
      yield* Effect.logWarning("Sleep prevention is not supported on this platform", {
        platform: process.platform,
      });
      return;
    }
    yield* Effect.acquireRelease(
      Effect.sync((): ChildProcess | null => {
        try {
          const child = spawn(command.command, [...command.args], { stdio: "ignore" });
          child.on("error", (error) => {
            void Effect.runPromise(
              Effect.logWarning("Sleep prevention could not start", {
                command: command.command,
                error: error.message,
              }),
            );
          });
          child.unref();
          return child;
        } catch {
          return null;
        }
      }).pipe(
        Effect.tap((child) =>
          child === null
            ? Effect.logWarning("Sleep prevention could not start", { command: command.command })
            : Effect.logInfo("Preventing sleep while this node runs", {
                via: command.description,
              }),
        ),
      ),
      (child) =>
        Effect.sync(() => {
          if (child !== null && child.exitCode === null) child.kill("SIGTERM");
        }),
    );
  }),
);
