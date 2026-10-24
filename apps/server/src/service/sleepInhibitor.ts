/**
 * Keep the machine from sleeping while this node needs it, through the OS tool that holds the
 * assertion (`caffeinate`, `systemd-inhibit`). The tool is tied to this process's pid, so the
 * assertion ends even if this process is killed without running its shutdown path.
 *
 * Two holds:
 *
 * - **Lifetime** (`--prevent-sleep`, the default for `ryco service`). A sleeping Mac drops every
 *   relay, LAN, and Tailscale connection and misses remote work, so a node meant to be reachable
 *   holds an assertion for exactly its own lifetime.
 * - **Agent work** (`--keep-awake-while-working`, on by default for every other headless node). An
 *   idle-sleep assertion held only while agents work and for the release tail after it
 *   ({@link AgentWorkActivity}), and only on AC power. Desktop mode never runs it: Desktop main
 *   holds the machine awake there.
 */
import { execFile, spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

import { Cause, Clock, Duration, Effect, Layer, Option, Queue, Stream } from "effect";

import { ServerConfig } from "../config.ts";
import { AgentWorkActivity } from "../orchestration/AgentWorkActivity.ts";

export interface SleepInhibitorCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly description: string;
}

/** What a hold is for: the whole run of this process, or only while agents work. */
export type SleepInhibitorPurpose = "lifetime" | "agent-work";

/**
 * The OS tool that holds the assertion, tied to `pid`.
 *
 * macOS: the lifetime hold uses `caffeinate -s`, which blocks system sleep only while on AC power,
 * so a laptop on battery still sleeps normally. The agent-work hold uses `caffeinate -i`, the same
 * idle-sleep assertion Desktop takes (`PreventUserIdleSystemSleep`): a closed lid or an explicit
 * sleep still sleeps. It does not check the power source itself, so its owner stops it on battery.
 * The display may sleep either way.
 *
 * Linux: both holds take logind's `sleep:idle` block lock. Besides idle suspend it also refuses an
 * unprivileged explicit suspend while it is held; a closed lid still suspends under logind's
 * default `LidSwitchIgnoreInhibited=yes`.
 */
export function sleepInhibitorCommand(
  platform: NodeJS.Platform,
  pid: number,
  purpose: SleepInhibitorPurpose = "lifetime",
): SleepInhibitorCommand | null {
  if (platform === "darwin") {
    return purpose === "lifetime"
      ? {
          command: "caffeinate",
          args: ["-s", "-w", String(pid)],
          description: "caffeinate (system sleep blocked while on AC power)",
        }
      : {
          command: "caffeinate",
          args: ["-i", "-w", String(pid)],
          description: "caffeinate (idle sleep blocked)",
        };
  }
  if (platform === "linux") {
    return {
      command: "systemd-inhibit",
      args: [
        "--what=sleep:idle",
        "--who=Ryco",
        purpose === "lifetime"
          ? "--why=Keeping this Ryco node reachable"
          : "--why=Ryco agents are working",
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

/** How a started tool ended: it exited, or it could not start at all. */
export type SleepInhibitorChildEnd =
  | {
      readonly kind: "exit";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly kind: "error"; readonly error: NodeJS.ErrnoException };

export interface SleepInhibitorChildEvents {
  /** The tool started. */
  readonly onSpawn?: () => void;
  /** The tool ended or could not start. Called at most once. */
  readonly onEnd?: (end: SleepInhibitorChildEnd) => void;
}

export interface SleepInhibitorChild {
  /** Ends the assertion; a no-op once the tool has ended. */
  readonly stop: () => void;
}

/** Starts a tool. Throws only when it cannot even be attempted. */
export type SpawnSleepInhibitor = (
  command: SleepInhibitorCommand,
  events: SleepInhibitorChildEvents,
) => SleepInhibitorChild;

/** Starts the tool detached from this process's stdio and event loop. */
export const startSleepInhibitorChild: SpawnSleepInhibitor = (command, events) => {
  const child = spawn(command.command, [...command.args], { stdio: "ignore" });
  let ended = false;
  const end = (value: SleepInhibitorChildEnd) => {
    if (ended) return;
    ended = true;
    events.onEnd?.(value);
  };
  child.once("spawn", () => events.onSpawn?.());
  // Kept for the child's life: an `error` without a listener (a failed kill) would throw.
  child.on("error", (error) => end({ kind: "error", error }));
  child.once("exit", (code, signal) => end({ kind: "exit", code, signal }));
  child.unref();
  return {
    stop: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    },
  };
};

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
    // The tool's callbacks log through this server's loggers, so the line reaches server.log.
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    yield* Effect.acquireRelease(
      Effect.sync((): SleepInhibitorChild | null => {
        try {
          return startSleepInhibitorChild(command, {
            onEnd: (end) => {
              if (end.kind !== "error") return;
              runFork(
                Effect.logWarning("Sleep prevention could not start", {
                  command: command.command,
                  error: end.error.message,
                }),
              );
            },
          });
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
      (child) => Effect.sync(() => child?.stop()),
    );
  }),
);

// ─── Power source ─────────────────────────────────────────────────────────────

/** Reads `/sys/class/power_supply`; injectable for tests. */
export interface PowerSupplyReader {
  readonly list: (directory: string) => Promise<ReadonlyArray<string>>;
  readonly read: (file: string) => Promise<string>;
}

const nodePowerSupplyReader: PowerSupplyReader = {
  list: (directory) => readdir(directory),
  read: (file) => readFile(file, "utf8"),
};

/** Supply types that power the machine from outside: a charger, a USB or a wireless source. */
const isExternalSupplyType = (type: string) =>
  type === "Mains" || type === "Wireless" || type.startsWith("USB");

/**
 * Whether this Linux machine runs on battery: no external supply is online and a system battery
 * is discharging. Batteries of peripherals (a wireless mouse or keyboard reports `scope=Device`)
 * never count, the same split UPower makes. Anything unreadable counts as AC, as do machines with
 * no supplies at all (servers, VMs, containers), so the hold errs on staying awake.
 */
export async function linuxOnBatteryPower(
  reader: PowerSupplyReader = nodePowerSupplyReader,
  root = "/sys/class/power_supply",
): Promise<boolean> {
  let supplies: ReadonlyArray<string>;
  try {
    supplies = await reader.list(root);
  } catch {
    return false;
  }
  const attribute = async (supply: string, name: string): Promise<string | undefined> => {
    try {
      return (await reader.read(`${root}/${supply}/${name}`)).trim();
    } catch {
      return undefined;
    }
  };
  let systemBatteryDischarging = false;
  for (const supply of supplies) {
    const type = await attribute(supply, "type");
    if (type === undefined) continue;
    if (isExternalSupplyType(type)) {
      if ((await attribute(supply, "online")) === "1") return false;
    } else if (type === "Battery") {
      if ((await attribute(supply, "scope")) === "Device") continue;
      if ((await attribute(supply, "status")) === "Discharging") systemBatteryDischarging = true;
    }
  }
  return systemBatteryDischarging;
}

/** Whether `pmset -g ps` output says the Mac draws from its battery. Anything else is AC. */
export function pmsetReportsBatteryPower(output: string): boolean {
  return /drawing from '([^']+)'/u.exec(output)?.[1] === "Battery Power";
}

const POWER_SOURCE_PROBE_TIMEOUT_MS = 2_000;

/**
 * Whether this Mac runs on battery, from `pmset -g ps`; a failure counts as AC. Its own timeout
 * kills a hung `pmset`; the owner's timeout bounds every probe, whatever the platform.
 */
export function darwinOnBatteryPower(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "pmset",
      ["-g", "ps"],
      { timeout: POWER_SOURCE_PROBE_TIMEOUT_MS, encoding: "utf8" },
      (error, stdout) => resolve(error === null && pmsetReportsBatteryPower(stdout)),
    );
  });
}

// ─── Agent-work hold ──────────────────────────────────────────────────────────

/** While agents work, re-check the power source this often. */
export const AGENT_WORK_POWER_CHECK_INTERVAL_MS = 60_000;
/** After the tool ends unexpectedly, wait this long times the failure count, then start it again. */
export const AGENT_WORK_HOLD_RETRY_BASE_MS = 5_000;
/**
 * Give up for this process after this many failures in a row. A start that is still running when
 * the hold releases it was not a failure, so it starts a new count.
 */
export const AGENT_WORK_HOLD_MAX_FAILURES = 3;
/** A tool that held this long before it ended was healthy: its end starts a new failure count. */
export const AGENT_WORK_HOLD_HEALTHY_MS = 60_000;

/** The parts of the process the agent-work hold uses; injectable for tests. */
export interface AgentWorkSleepInhibitorRuntime {
  readonly platform: NodeJS.Platform;
  readonly pid: number;
  readonly spawn: SpawnSleepInhibitor;
  /** Whether the machine runs on battery now. Anything it cannot tell should read as AC. */
  readonly onBatteryPower: () => Promise<boolean>;
}

export const defaultAgentWorkSleepInhibitorRuntime: AgentWorkSleepInhibitorRuntime = {
  platform: process.platform,
  pid: process.pid,
  spawn: startSleepInhibitorChild,
  onBatteryPower: () =>
    process.platform === "darwin"
      ? darwinOnBatteryPower()
      : process.platform === "linux"
        ? linuxOnBatteryPower()
        : Promise.resolve(false),
};

/** One start of the tool. Its callbacks record what happened here and wake the owner. */
interface AgentWorkHold {
  child: SleepInhibitorChild | null;
  readonly startedAtMs: number;
  spawned: boolean;
  end: SleepInhibitorChildEnd | null;
}

const describeEnd = (end: SleepInhibitorChildEnd) =>
  end.kind === "error"
    ? { error: end.error.message, ...(end.error.code ? { code: end.error.code } : {}) }
    : { exitCode: end.code, signal: end.signal };

/**
 * Holds an idle-sleep assertion while {@link AgentWorkActivity} says to keep the machine awake,
 * on AC power only.
 *
 * One owner fiber decides everything. The activity feed and the tool's callbacks only record what
 * they saw and wake it; it then derives the hold from that state, so a coalesced wake-up loses
 * nothing. While work runs, the owner checks the power source when work starts and then every
 * {@link AGENT_WORK_POWER_CHECK_INTERVAL_MS}; while idle it does nothing at all. A tool that ends
 * on its own is started again after a backoff. After {@link AGENT_WORK_HOLD_MAX_FAILURES} failures
 * in a row, or when the tool is missing, the hold gives up for this process with one log line. A
 * start that held for {@link AGENT_WORK_HOLD_HEALTHY_MS}, or until the hold released it, is not a
 * failure, so only a tool that keeps ending soon after it starts gives up; one that holds for
 * minutes between ends is started again each time. Nothing blocks startup.
 */
export const makeAgentWorkSleepInhibitor = (runtime: AgentWorkSleepInhibitorRuntime) =>
  Effect.gen(function* () {
    const activity = yield* AgentWorkActivity;
    const command = sleepInhibitorCommand(runtime.platform, runtime.pid, "agent-work");
    if (command === null) {
      yield* Effect.logDebug(
        "Keeping this machine awake while agents work is not supported on this platform",
        { platform: runtime.platform },
      );
      return;
    }

    // Wake-ups coalesce: one pending wake-up covers any number of changes, and offering never blocks.
    const wake = yield* Queue.sliding<void>(1);
    const signal = () => {
      Queue.offerUnsafe(wake, undefined);
    };
    // The latest `keepAwake` from the activity; written by the feed, read by the owner.
    let wanted = false;
    // Everything below is changed only by the owner fiber, and by the finalizer once it stopped.
    let held: AgentWorkHold | null = null;
    let failures = 0;
    let retryAtMs: number | null = null;
    let gaveUp = false;
    let closed = false;
    let announced = false;
    // The last power-source answer during this work period, and when it was asked for.
    let onBattery = false;
    let powerCheckedAtMs: number | null = null;

    // Added before the fibers are forked, so it runs after they are interrupted.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true;
        const current = held;
        held = null;
        current?.child?.stop();
      }),
    );

    const release = (reason: string) =>
      Effect.gen(function* () {
        const current = held;
        if (current === null) return;
        held = null;
        // It ran until it was no longer wanted: a success, so earlier failures were not in a row.
        if (current.spawned && current.end === null) failures = 0;
        current.child?.stop();
        yield* Effect.logDebug("agent work: released the sleep assertion", { reason });
      });

    const onBatteryPower = Effect.tryPromise(() => runtime.onBatteryPower()).pipe(
      Effect.timeoutOption(Duration.millis(POWER_SOURCE_PROBE_TIMEOUT_MS)),
      Effect.map(Option.getOrElse(() => false)),
      Effect.orElseSucceed(() => false),
    );

    const fail = (startedAtMs: number, end: SleepInhibitorChildEnd) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        if (nowMs - startedAtMs >= AGENT_WORK_HOLD_HEALTHY_MS) failures = 0;
        failures += 1;
        if (end.kind === "error" && end.error.code === "ENOENT") {
          gaveUp = true;
          yield* Effect.logInfo(
            "Keeping this machine awake while agents work is not available: its tool was not found",
            { command: command.command },
          );
        } else if (failures >= AGENT_WORK_HOLD_MAX_FAILURES) {
          gaveUp = true;
          yield* Effect.logWarning(
            "Keeping this machine awake while agents work stopped: its tool kept ending",
            { via: command.description, failures, ...describeEnd(end) },
          );
        } else {
          retryAtMs = nowMs + AGENT_WORK_HOLD_RETRY_BASE_MS * failures;
          yield* Effect.logDebug("agent work: the sleep assertion ended; starting it again soon", {
            failures,
            ...describeEnd(end),
          });
        }
      });

    const acquire = Effect.gen(function* () {
      const hold: AgentWorkHold = {
        child: null,
        startedAtMs: yield* Clock.currentTimeMillis,
        spawned: false,
        end: null,
      };
      try {
        hold.child = runtime.spawn(command, {
          onSpawn: () => {
            hold.spawned = true;
            signal();
          },
          onEnd: (end) => {
            hold.end = end;
            signal();
          },
        });
      } catch (error) {
        const spawnError: NodeJS.ErrnoException =
          error instanceof Error ? error : new Error(String(error));
        yield* fail(hold.startedAtMs, { kind: "error", error: spawnError });
        return;
      }
      held = hold;
      yield* Effect.logDebug("agent work: holding a sleep assertion", {
        via: command.description,
      });
    });

    // Derive the hold from what is known now. A power probe runs only while work wants the hold,
    // when work starts and when the last answer is due for a re-check, never on the tool's events.
    const step = Effect.gen(function* () {
      if (closed) return;
      const current = held;
      if (current !== null) {
        if (current.spawned && !announced) {
          announced = true;
          yield* Effect.logInfo("Keeping this machine awake while agents work", {
            via: command.description,
          });
        }
        if (current.end !== null) {
          held = null;
          yield* fail(current.startedAtMs, current.end);
        }
      }
      if (!wanted || gaveUp) {
        retryAtMs = null;
        // The next work period asks for the power source afresh.
        powerCheckedAtMs = null;
        yield* release(gaveUp ? "gave up" : "agents stopped working");
        return;
      }
      const checkAtMs = yield* Clock.currentTimeMillis;
      if (
        powerCheckedAtMs === null ||
        checkAtMs - powerCheckedAtMs >= AGENT_WORK_POWER_CHECK_INTERVAL_MS
      ) {
        const answer = yield* onBatteryPower;
        // The probe waited; work may have stopped meanwhile, and its wake-up is already pending.
        if (closed || !wanted) return;
        onBattery = answer;
        powerCheckedAtMs = checkAtMs;
      }
      if (onBattery) {
        // No retry is due on battery: a past-due one would make every wait return at once. Back on
        // AC power, the next check starts the tool without the backoff; the failure count stays.
        retryAtMs = null;
        yield* release("on battery power");
        return;
      }
      if (held !== null) return;
      const nowMs = yield* Clock.currentTimeMillis;
      if (retryAtMs !== null && nowMs < retryAtMs) return;
      retryAtMs = null;
      yield* acquire;
    });

    // Wait for the next change, a due retry, or the next power check while work runs.
    const nextWakeInMs = Effect.gen(function* () {
      if (closed || gaveUp || !wanted) return null;
      const nowMs = yield* Clock.currentTimeMillis;
      const untilPowerCheck =
        powerCheckedAtMs === null
          ? 0
          : powerCheckedAtMs + AGENT_WORK_POWER_CHECK_INTERVAL_MS - nowMs;
      const untilRetry = retryAtMs === null ? untilPowerCheck : retryAtMs - nowMs;
      return Math.max(0, Math.min(untilPowerCheck, untilRetry));
    });

    const iteration = Effect.gen(function* () {
      const wakeInMs = yield* nextWakeInMs;
      yield* wakeInMs === null
        ? Queue.take(wake)
        : Queue.take(wake).pipe(Effect.timeoutOption(Duration.millis(wakeInMs)));
      yield* step;
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.gen(function* () {
              yield* Effect.logError("agent work: the sleep hold failed; releasing it", {
                cause: Cause.pretty(cause),
              });
              yield* release("failure");
            }),
      ),
    );

    yield* activity.changes.pipe(
      Stream.map((state) => state.keepAwake),
      Stream.changes,
      Stream.runForEach((value) =>
        Effect.sync(() => {
          wanted = value;
          signal();
        }),
      ),
      Effect.forkScoped,
    );
    yield* Effect.forkScoped(Effect.forever(iteration));
  });

export const AgentWorkSleepInhibitorLive = Layer.effectDiscard(
  makeAgentWorkSleepInhibitor(defaultAgentWorkSleepInhibitorRuntime),
);
