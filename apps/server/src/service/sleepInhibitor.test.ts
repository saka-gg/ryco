import { assert, describe, it } from "@effect/vitest";
import { Clock, Duration, Effect, Exit, Logger, Scope, SubscriptionRef } from "effect";
import { TestClock } from "effect/testing";

import {
  AgentWorkActivity,
  type AgentWorkState,
  IDLE_AGENT_WORK,
} from "../orchestration/AgentWorkActivity.ts";
import {
  AGENT_WORK_HOLD_HEALTHY_MS,
  AGENT_WORK_HOLD_RETRY_BASE_MS,
  AGENT_WORK_POWER_CHECK_INTERVAL_MS,
  type AgentWorkSleepInhibitorRuntime,
  linuxOnBatteryPower,
  makeAgentWorkSleepInhibitor,
  pmsetReportsBatteryPower,
  type PowerSupplyReader,
  type SleepInhibitorChildEnd,
  type SleepInhibitorChildEvents,
  type SleepInhibitorCommand,
  sleepInhibitorCommand,
} from "./sleepInhibitor.ts";

describe("sleepInhibitorCommand", () => {
  it("holds idle sleep only while agents work on macOS, and all sleep for the lifetime hold", () => {
    assert.deepStrictEqual(sleepInhibitorCommand("darwin", 42)?.args, ["-s", "-w", "42"]);
    assert.deepStrictEqual(sleepInhibitorCommand("darwin", 42, "lifetime")?.args, [
      "-s",
      "-w",
      "42",
    ]);
    const agentWork = sleepInhibitorCommand("darwin", 42, "agent-work");
    assert.strictEqual(agentWork?.command, "caffeinate");
    assert.deepStrictEqual(agentWork?.args, ["-i", "-w", "42"]);
  });

  it("names why it holds on Linux and is otherwise the same command", () => {
    const lifetime = sleepInhibitorCommand("linux", 42, "lifetime");
    const agentWork = sleepInhibitorCommand("linux", 42, "agent-work");
    assert.strictEqual(lifetime?.command, "systemd-inhibit");
    assert.include([...(lifetime?.args ?? [])], "--why=Keeping this Ryco node reachable");
    assert.include([...(agentWork?.args ?? [])], "--why=Ryco agents are working");
    const withoutWhy = (args: ReadonlyArray<string> | undefined) =>
      args?.filter((arg) => !arg.startsWith("--why="));
    assert.deepStrictEqual(withoutWhy(agentWork?.args), withoutWhy(lifetime?.args));
    assert.include([...(agentWork?.args ?? [])], "--pid=42");
  });

  it("is not supported elsewhere", () => {
    assert.isNull(sleepInhibitorCommand("win32", 42));
    assert.isNull(sleepInhibitorCommand("win32", 42, "agent-work"));
  });
});

/** A fake `/sys/class/power_supply`: supply name to attributes. */
function powerSupplies(
  supplies: Record<string, Record<string, string>> | "unreadable",
): PowerSupplyReader {
  return {
    list: async () => {
      if (supplies === "unreadable") throw new Error("EACCES");
      return Object.keys(supplies);
    },
    read: async (file) => {
      if (supplies === "unreadable") throw new Error("EACCES");
      const [supply, attribute] = file.split("/").slice(-2) as [string, string];
      const value = supplies[supply]?.[attribute];
      if (value === undefined) throw new Error("ENOENT");
      return `${value}\n`;
    },
  };
}

describe("linuxOnBatteryPower", () => {
  const cases: ReadonlyArray<
    readonly [string, Record<string, Record<string, string>> | "unreadable", boolean]
  > = [
    [
      "a charger online",
      { AC: { type: "Mains", online: "1" }, BAT0: { type: "Battery", status: "Charging" } },
      false,
    ],
    [
      "charger offline and the battery discharging",
      { AC: { type: "Mains", online: "0" }, BAT0: { type: "Battery", status: "Discharging" } },
      true,
    ],
    ["only a full battery", { BAT0: { type: "Battery", status: "Full" } }, false],
    ["no supplies (a server or VM)", {}, false],
    ["an unreadable power_supply directory", "unreadable", false],
    [
      "USB-C power online and a discharging battery",
      {
        ucsi: { type: "USB", online: "1" },
        BAT0: { type: "Battery", status: "Discharging", scope: "System" },
      },
      false,
    ],
    [
      "no charger entry and a discharging wireless mouse (a desktop PC)",
      { hidpp_battery_0: { type: "Battery", status: "Discharging", scope: "Device" } },
      false,
    ],
    [
      "a discharging system battery next to a peripheral one",
      {
        hidpp_battery_0: { type: "Battery", status: "Full", scope: "Device" },
        BAT1: { type: "Battery", status: "Discharging", scope: "System" },
      },
      true,
    ],
    ["a supply whose type cannot be read", { odd: { status: "Discharging" } }, false],
  ];
  for (const [name, supplies, expected] of cases) {
    it(`${name} → ${expected ? "battery" : "AC"}`, async () => {
      assert.strictEqual(await linuxOnBatteryPower(powerSupplies(supplies)), expected);
    });
  }
});

describe("pmsetReportsBatteryPower", () => {
  it("reads the power source pmset names", () => {
    assert.isFalse(
      pmsetReportsBatteryPower(
        "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t85%; charging; 1:36 remaining present: true\n",
      ),
    );
    assert.isTrue(
      pmsetReportsBatteryPower(
        "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t85%; discharging; 4:10 remaining present: true\n",
      ),
    );
    assert.isFalse(pmsetReportsBatteryPower("Now drawing from 'UPS Power'\n"));
    assert.isFalse(pmsetReportsBatteryPower(""));
  });
});

const settle = Effect.gen(function* () {
  for (let round = 0; round < 4; round += 1) {
    for (let index = 0; index < 20; index += 1) yield* Effect.yieldNow;
    yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
  }
});

const exited: SleepInhibitorChildEnd = { kind: "exit", code: 1, signal: null };

interface FakeChild {
  readonly command: SleepInhibitorCommand;
  readonly events: SleepInhibitorChildEvents;
  stopped: boolean;
  ended: boolean;
}

/** A runtime that records every start and lets a test end, or fail, the tool. */
function fakeRuntime(options: { readonly platform?: NodeJS.Platform } = {}) {
  const children: FakeChild[] = [];
  let onBattery = false;
  let spawnError: Error | null = null;
  const runtime: AgentWorkSleepInhibitorRuntime = {
    platform: options.platform ?? "darwin",
    pid: 4242,
    spawn: (command, events) => {
      if (spawnError !== null) throw spawnError;
      const child: FakeChild = { command, events, stopped: false, ended: false };
      children.push(child);
      queueMicrotask(() => events.onSpawn?.());
      return {
        stop: () => {
          child.stopped = true;
        },
      };
    },
    onBatteryPower: () => Promise.resolve(onBattery),
  };
  return {
    runtime,
    children,
    running: () => children.filter((child) => !child.stopped && !child.ended),
    /** The latest tool ends on its own. */
    end: (end: SleepInhibitorChildEnd = exited) => {
      const child = children.at(-1);
      if (child === undefined) throw new Error("no tool was started");
      child.ended = true;
      child.events.onEnd?.(end);
      return settle;
    },
    setOnBattery: (value: boolean) => {
      onBattery = value;
    },
    failSpawnWith: (error: Error | null) => {
      spawnError = error;
    },
  };
}

/** The test clock, recording every sleep the hold schedules on it (a busy loop shows as many). */
const recordingSleeps = TestClock.testClockWith((testClock) => {
  const sleeps: Array<number> = [];
  const clock: Clock.Clock = {
    ...testClock,
    sleep: (duration) => {
      sleeps.push(Duration.toMillis(duration));
      return testClock.sleep(duration);
    },
  };
  return Effect.succeed({ sleeps, clock });
});

/**
 * The test clock with a wall clock that can be stepped (an NTP step, a manual change). Timers and
 * the monotonic clock keep running on the test clock, as `setTimeout` does in production.
 */
const steppableWallClock = TestClock.testClockWith((testClock) => {
  let offsetMs = 0;
  const currentTimeMillisUnsafe = () => testClock.currentTimeMillisUnsafe() + offsetMs;
  const currentTimeNanosUnsafe = () =>
    testClock.currentTimeNanosUnsafe() + BigInt(offsetMs) * 1_000_000n;
  const clock: Clock.Clock = {
    ...testClock,
    currentTimeMillisUnsafe,
    currentTimeMillis: Effect.sync(currentTimeMillisUnsafe),
    currentTimeNanosUnsafe,
    currentTimeNanos: Effect.sync(currentTimeNanosUnsafe),
  };
  return Effect.succeed({
    clock,
    stepWallClock: (ms: number) => {
      offsetMs += ms;
    },
  });
});

/** Runs the hold in `scope` against a settable agent-work state. */
const startHold = (
  runtime: AgentWorkSleepInhibitorRuntime,
  scope: Scope.Scope,
  options: { readonly clock?: Clock.Clock } = {},
) =>
  Effect.gen(function* () {
    const ref = yield* SubscriptionRef.make<AgentWorkState>(IDLE_AGENT_WORK);
    const clock = options.clock ?? (yield* Clock.Clock);
    yield* makeAgentWorkSleepInhibitor(runtime).pipe(
      Effect.provideService(AgentWorkActivity, {
        current: SubscriptionRef.get(ref),
        changes: SubscriptionRef.changes(ref),
      }),
      Effect.provideService(Clock.Clock, clock),
      Scope.provide(scope),
    );
    const report = (state: AgentWorkState) =>
      SubscriptionRef.set(ref, state).pipe(Effect.andThen(settle));
    const advance = (ms: number) => TestClock.adjust(`${ms} millis`).pipe(Effect.andThen(settle));
    yield* settle;
    return { report, advance };
  });

const working: AgentWorkState = { working: true, keepAwake: true };
const tail: AgentWorkState = { working: false, keepAwake: true };

describe("makeAgentWorkSleepInhibitor", () => {
  it.effect("holds the machine awake exactly while agents work", () =>
    Effect.gen(function* () {
      const fake = fakeRuntime();
      const scope = yield* Scope.make();
      const hold = yield* startHold(fake.runtime, scope);
      assert.strictEqual(fake.children.length, 0);

      yield* hold.report(working);
      assert.strictEqual(fake.children.length, 1);
      assert.strictEqual(fake.children[0]?.command.command, "caffeinate");
      assert.deepStrictEqual(fake.children[0]?.command.args, ["-i", "-w", "4242"]);
      assert.isFalse(fake.children[0]?.stopped);

      // The release tail and repeated reports keep the one hold.
      yield* hold.report(tail);
      yield* hold.report(working);
      yield* hold.advance(AGENT_WORK_POWER_CHECK_INTERVAL_MS * 3);
      assert.strictEqual(fake.children.length, 1);
      assert.isFalse(fake.children[0]?.stopped);

      yield* hold.report(IDLE_AGENT_WORK);
      assert.isTrue(fake.children[0]?.stopped);
      yield* hold.advance(AGENT_WORK_POWER_CHECK_INTERVAL_MS * 3);
      assert.strictEqual(fake.children.length, 1);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("starts the tool again after it ends, and gives up after three failures", () => {
    const warnings: string[] = [];
    const logger = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(String(message));
    });
    return Effect.gen(function* () {
      const fake = fakeRuntime();
      const scope = yield* Scope.make();
      const hold = yield* startHold(fake.runtime, scope);
      yield* hold.report(working);
      assert.strictEqual(fake.children.length, 1);

      yield* fake.end();
      yield* hold.advance(AGENT_WORK_HOLD_RETRY_BASE_MS - 1);
      assert.strictEqual(fake.children.length, 1);
      yield* hold.advance(1);
      assert.strictEqual(fake.children.length, 2);

      yield* fake.end();
      yield* hold.advance(AGENT_WORK_HOLD_RETRY_BASE_MS * 2 - 1);
      assert.strictEqual(fake.children.length, 2);
      yield* hold.advance(1);
      assert.strictEqual(fake.children.length, 3);

      yield* fake.end();
      yield* hold.advance(AGENT_WORK_HOLD_RETRY_BASE_MS * 10);
      yield* hold.report(IDLE_AGENT_WORK);
      yield* hold.report(working);
      yield* hold.advance(AGENT_WORK_HOLD_RETRY_BASE_MS * 10);
      assert.strictEqual(fake.children.length, 3);
      assert.strictEqual(warnings.length, 1);
      assert.include(warnings[0], "stopped");
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });

  it.effect("gives up at once, without a warning, when the tool is missing", () => {
    const warnings: string[] = [];
    const infos: string[] = [];
    const logger = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(String(message));
      if (logLevel === "Info") infos.push(String(message));
    });
    return Effect.gen(function* () {
      const fake = fakeRuntime({ platform: "linux" });
      const scope = yield* Scope.make();
      const hold = yield* startHold(fake.runtime, scope);
      yield* hold.report(working);
      const missing = Object.assign(new Error("spawn systemd-inhibit ENOENT"), {
        code: "ENOENT",
      });
      yield* fake.end({ kind: "error", error: missing });
      yield* hold.advance(AGENT_WORK_HOLD_RETRY_BASE_MS * 10);
      yield* hold.report(IDLE_AGENT_WORK);
      yield* hold.report(working);
      yield* hold.advance(AGENT_WORK_HOLD_RETRY_BASE_MS * 10);
      assert.strictEqual(fake.children.length, 1);
      assert.deepStrictEqual(warnings, []);
      assert.isTrue(infos.some((message) => message.includes("not available")));
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });

  it.effect("counts a start that throws as a failure and tries again", () =>
    Effect.gen(function* () {
      const fake = fakeRuntime();
      fake.failSpawnWith(new Error("EAGAIN"));
      const scope = yield* Scope.make();
      const hold = yield* startHold(fake.runtime, scope);
      yield* hold.report(working);
      assert.strictEqual(fake.children.length, 0);
      fake.failSpawnWith(null);
      yield* hold.advance(AGENT_WORK_HOLD_RETRY_BASE_MS);
      assert.strictEqual(fake.children.length, 1);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("a tool that held for a while starts a new failure count when it ends", () =>
    Effect.gen(function* () {
      const fake = fakeRuntime();
      const scope = yield* Scope.make();
      const hold = yield* startHold(fake.runtime, scope);
      yield* hold.report(working);
      // Five ends, each after a healthy hold: never three failures in a row.
      for (let end = 0; end < 5; end += 1) {
        yield* hold.advance(AGENT_WORK_HOLD_HEALTHY_MS);
        yield* fake.end();
        yield* hold.advance(AGENT_WORK_HOLD_RETRY_BASE_MS);
      }
      assert.strictEqual(fake.children.length, 6);
      assert.strictEqual(fake.running().length, 1);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("a hold released while its tool runs starts a new failure count", () => {
    const warnings: string[] = [];
    const logger = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(String(message));
    });
    return Effect.gen(function* () {
      const fake = fakeRuntime();
      const scope = yield* Scope.make();
      const hold = yield* startHold(fake.runtime, scope);
      // Three work periods, each with one quick failure and a restart that held until work stopped:
      // three failures, but never in a row.
      for (let period = 0; period < 3; period += 1) {
        yield* hold.report(working);
        yield* fake.end();
        yield* hold.advance(AGENT_WORK_HOLD_RETRY_BASE_MS);
        assert.strictEqual(fake.running().length, 1);
        yield* hold.report(IDLE_AGENT_WORK);
      }
      yield* hold.report(working);
      assert.strictEqual(fake.children.length, 7);
      assert.strictEqual(fake.running().length, 1);
      assert.deepStrictEqual(warnings, []);
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });

  it.effect("holds only on AC power, and re-checks the power source while work runs", () =>
    Effect.gen(function* () {
      const fake = fakeRuntime({ platform: "linux" });
      fake.setOnBattery(true);
      const scope = yield* Scope.make();
      const hold = yield* startHold(fake.runtime, scope);
      yield* hold.report(working);
      assert.strictEqual(fake.children.length, 0);

      fake.setOnBattery(false);
      yield* hold.advance(AGENT_WORK_POWER_CHECK_INTERVAL_MS);
      assert.strictEqual(fake.children.length, 1);
      assert.strictEqual(fake.children[0]?.command.command, "systemd-inhibit");
      assert.include([...(fake.children[0]?.command.args ?? [])], "--why=Ryco agents are working");

      fake.setOnBattery(true);
      yield* hold.advance(AGENT_WORK_POWER_CHECK_INTERVAL_MS);
      assert.isTrue(fake.children[0]?.stopped);

      fake.setOnBattery(false);
      yield* hold.advance(AGENT_WORK_POWER_CHECK_INTERVAL_MS);
      assert.strictEqual(fake.running().length, 1);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("checks the power source only while agents work", () =>
    Effect.gen(function* () {
      const fake = fakeRuntime();
      let probes = 0;
      const runtime: AgentWorkSleepInhibitorRuntime = {
        ...fake.runtime,
        onBatteryPower: () => {
          probes += 1;
          return Promise.resolve(false);
        },
      };
      const scope = yield* Scope.make();
      const hold = yield* startHold(runtime, scope);
      yield* hold.advance(AGENT_WORK_POWER_CHECK_INTERVAL_MS * 10);
      assert.strictEqual(probes, 0);
      yield* hold.report(working);
      // One check when work starts (not another when the tool reports it started), then one a minute.
      assert.strictEqual(probes, 1);
      yield* hold.advance(AGENT_WORK_POWER_CHECK_INTERVAL_MS * 2);
      assert.strictEqual(probes, 3);
      yield* hold.report(IDLE_AGENT_WORK);
      yield* hold.advance(AGENT_WORK_POWER_CHECK_INTERVAL_MS * 10);
      assert.strictEqual(probes, 3);
      // A new work period asks afresh.
      yield* hold.report(working);
      assert.strictEqual(probes, 4);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("waits out a failure on battery without starting the tool, and starts it on AC", () =>
    Effect.gen(function* () {
      const fake = fakeRuntime();
      let probes = 0;
      let onBattery = false;
      const runtime: AgentWorkSleepInhibitorRuntime = {
        ...fake.runtime,
        onBatteryPower: () => {
          probes += 1;
          return Promise.resolve(onBattery);
        },
      };
      const recorded = yield* recordingSleeps;
      const scope = yield* Scope.make();
      const hold = yield* startHold(runtime, scope, { clock: recorded.clock });
      yield* hold.report(working);
      assert.strictEqual(fake.children.length, 1);

      // The tool ends just before the next check, which then finds the battery: no restart, and
      // the retry that was pending does not turn every wait into an immediate wake-up.
      yield* hold.advance(AGENT_WORK_POWER_CHECK_INTERVAL_MS - 1_000);
      yield* fake.end();
      onBattery = true;
      yield* hold.advance(1_000);
      yield* hold.advance(AGENT_WORK_HOLD_RETRY_BASE_MS * 2);
      assert.strictEqual(fake.children.length, 1);
      assert.strictEqual(probes, 2);
      assert.isBelow(recorded.sleeps.length, 20);

      onBattery = false;
      yield* hold.advance(AGENT_WORK_POWER_CHECK_INTERVAL_MS - AGENT_WORK_HOLD_RETRY_BASE_MS * 2);
      assert.strictEqual(probes, 3);
      assert.strictEqual(fake.running().length, 1);
      assert.strictEqual(fake.children.length, 2);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("re-checks the power source on time after the wall clock jumps back", () =>
    Effect.gen(function* () {
      const fake = fakeRuntime();
      const wall = yield* steppableWallClock;
      const scope = yield* Scope.make();
      const hold = yield* startHold(fake.runtime, scope, { clock: wall.clock });
      yield* hold.report(working);
      assert.strictEqual(fake.running().length, 1);

      wall.stepWallClock(-3_600_000);
      fake.setOnBattery(true);
      yield* hold.advance(AGENT_WORK_POWER_CHECK_INTERVAL_MS);
      assert.isTrue(fake.children[0]?.stopped);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("starts the tool again on time after the wall clock jumps back", () =>
    Effect.gen(function* () {
      const fake = fakeRuntime();
      const wall = yield* steppableWallClock;
      const scope = yield* Scope.make();
      const hold = yield* startHold(fake.runtime, scope, { clock: wall.clock });
      yield* hold.report(working);
      yield* fake.end();

      wall.stepWallClock(-3_600_000);
      yield* hold.advance(AGENT_WORK_HOLD_RETRY_BASE_MS);
      assert.strictEqual(fake.children.length, 2);
      assert.strictEqual(fake.running().length, 1);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("counts a healthy hold as healthy after the wall clock jumps back", () =>
    Effect.gen(function* () {
      const fake = fakeRuntime();
      const wall = yield* steppableWallClock;
      const scope = yield* Scope.make();
      const hold = yield* startHold(fake.runtime, scope, { clock: wall.clock });
      yield* hold.report(working);
      for (let end = 0; end < 3; end += 1) {
        yield* hold.advance(AGENT_WORK_HOLD_HEALTHY_MS);
        wall.stepWallClock(-3_600_000);
        yield* fake.end();
        yield* hold.advance(AGENT_WORK_HOLD_RETRY_BASE_MS);
      }
      assert.strictEqual(fake.children.length, 4);
      assert.strictEqual(fake.running().length, 1);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("counts a power probe that never answers as AC power", () =>
    Effect.gen(function* () {
      const fake = fakeRuntime();
      const runtime: AgentWorkSleepInhibitorRuntime = {
        ...fake.runtime,
        onBatteryPower: () => new Promise<boolean>(() => {}),
      };
      const scope = yield* Scope.make();
      const hold = yield* startHold(runtime, scope);
      yield* hold.report(working);
      assert.strictEqual(fake.children.length, 0);
      yield* hold.advance(2_000);
      assert.strictEqual(fake.children.length, 1);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("treats a failing power probe as AC power", () =>
    Effect.gen(function* () {
      const fake = fakeRuntime();
      const runtime: AgentWorkSleepInhibitorRuntime = {
        ...fake.runtime,
        onBatteryPower: () => Promise.reject(new Error("pmset failed")),
      };
      const scope = yield* Scope.make();
      const hold = yield* startHold(runtime, scope);
      yield* hold.report(working);
      assert.strictEqual(fake.children.length, 1);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("stops the tool when the server shuts down and never starts it again", () =>
    Effect.gen(function* () {
      const fake = fakeRuntime();
      const scope = yield* Scope.make();
      const hold = yield* startHold(fake.runtime, scope);
      yield* hold.report(working);
      assert.strictEqual(fake.running().length, 1);

      yield* Scope.close(scope, Exit.void);
      assert.isTrue(fake.children[0]?.stopped);
      // The tool's late exit after shutdown changes nothing.
      yield* fake.end({ kind: "exit", code: null, signal: "SIGTERM" });
      yield* TestClock.adjust(`${AGENT_WORK_HOLD_RETRY_BASE_MS * 10} millis`);
      yield* settle;
      assert.strictEqual(fake.children.length, 1);
    }),
  );

  it.effect("does nothing on a platform without a tool", () =>
    Effect.gen(function* () {
      const fake = fakeRuntime({ platform: "win32" });
      const scope = yield* Scope.make();
      const hold = yield* startHold(fake.runtime, scope);
      yield* hold.report(working);
      yield* hold.advance(AGENT_WORK_POWER_CHECK_INTERVAL_MS);
      assert.strictEqual(fake.children.length, 0);
      yield* Scope.close(scope, Exit.void);
    }),
  );
});
