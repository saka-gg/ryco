import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Metric } from "effect";

import {
  ProcessPool,
  governChildProcess,
  governChildProcessPromise,
  inBackgroundProcessLane,
  processGovernorMetricNames,
  processGovernorStats,
  processPoolForCommand,
} from "./processGovernor.ts";

const forgeGauge = (snapshots: ReadonlyArray<Metric.Metric.Snapshot>, id: string) => {
  const snapshot = snapshots.find((item) => item.id === id && item.attributes?.pool === "forge");
  const state = snapshot?.state as { readonly value?: unknown } | undefined;
  return typeof state?.value === "number" ? state.value : undefined;
};

describe("processPoolForCommand", () => {
  it("governs git and forge CLIs by executable name", () => {
    assert.strictEqual(processPoolForCommand("git"), "git");
    assert.strictEqual(processPoolForCommand("/usr/bin/git"), "git");
    assert.strictEqual(processPoolForCommand("C:\\Program Files\\Git\\cmd\\git.exe"), "git");
    assert.strictEqual(processPoolForCommand("gh"), "forge");
    assert.strictEqual(processPoolForCommand("glab"), "forge");
    assert.strictEqual(processPoolForCommand("az.cmd"), "forge");
    assert.strictEqual(processPoolForCommand("node"), null);
    assert.strictEqual(processPoolForCommand("codex"), null);
  });
});

describe("ProcessPool", () => {
  it("admits interactive work at once and queues background work past the limit", () => {
    const pool = new ProcessPool("git", 2, () => 0);
    const releases: Array<() => void> = [];
    const order: string[] = [];
    const take = (label: string, lane: "interactive" | "background") =>
      pool.request(lane, (release) => {
        order.push(label);
        releases.push(release);
      });

    take("bg-1", "background");
    take("bg-2", "background");
    take("bg-3", "background");
    take("bg-4", "background");
    // Interactive work never waits behind a background burst.
    take("ui-1", "interactive");
    assert.deepStrictEqual(order, ["bg-1", "bg-2", "ui-1"]);
    assert.include(pool.stats(), { inFlight: 3, queued: 2 });

    // Background work resumes only once the pool is back under its limit.
    releases[0]?.();
    assert.deepStrictEqual(order, ["bg-1", "bg-2", "ui-1"]);
    releases[1]?.();
    assert.deepStrictEqual(order, ["bg-1", "bg-2", "ui-1", "bg-3"]);
    // Releasing twice is harmless.
    releases[1]?.();
    assert.include(pool.stats(), { inFlight: 2, queued: 1 });
    releases[2]?.();
    assert.deepStrictEqual(order, ["bg-1", "bg-2", "ui-1", "bg-3", "bg-4"]);
  });

  it("withdraws a queued request on cancel without granting it", () => {
    const pool = new ProcessPool("forge", 1, () => 0);
    let firstRelease: (() => void) | undefined;
    pool.request("background", (release) => {
      firstRelease = release;
    });
    let granted = false;
    const queued = pool.request("background", () => {
      granted = true;
    });
    queued.cancel();
    firstRelease?.();
    assert.isFalse(granted);
    assert.include(pool.stats(), { inFlight: 0, queued: 0 });
  });
});

describe("governChildProcess", () => {
  it.effect("holds background children while interactive ones fill the pool", () =>
    Effect.gen(function* () {
      const limit = processGovernorStats().find((stats) => stats.pool === "forge")?.limit ?? 4;
      const releaseInteractive = yield* Deferred.make<void>();
      const interactive = yield* Effect.forEach(Array.from({ length: limit }), () =>
        governChildProcess("gh", Deferred.await(releaseInteractive)).pipe(Effect.forkChild),
      );
      yield* Effect.yieldNow;

      let backgroundRan = false;
      const background = yield* governChildProcess(
        "gh",
        Effect.sync(() => {
          backgroundRan = true;
        }),
      ).pipe(inBackgroundProcessLane, Effect.forkChild);
      yield* Effect.yieldNow;
      assert.isFalse(backgroundRan);

      yield* Deferred.succeed(releaseInteractive, undefined);
      yield* Fiber.join(background);
      yield* Effect.forEach(interactive, Fiber.join);
      assert.isTrue(backgroundRan);
      assert.include(
        processGovernorStats().find((stats) => stats.pool === "forge"),
        {
          inFlight: 0,
          queued: 0,
        },
      );
    }),
  );

  it.effect("publishes the pool's in-flight and queued counts as gauges", () =>
    Effect.gen(function* () {
      const limit = processGovernorStats().find((stats) => stats.pool === "forge")?.limit ?? 4;
      const release = yield* Deferred.make<void>();
      const holders = yield* Effect.forEach(Array.from({ length: limit }), () =>
        governChildProcess("gh", Deferred.await(release)).pipe(Effect.forkChild),
      );
      yield* Effect.yieldNow;
      const queued = yield* governChildProcess("gh", Effect.void).pipe(
        inBackgroundProcessLane,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      const busy = yield* Metric.snapshot;
      assert.strictEqual(forgeGauge(busy, processGovernorMetricNames.inFlight), limit);
      assert.strictEqual(forgeGauge(busy, processGovernorMetricNames.queued), 1);

      yield* Deferred.succeed(release, undefined);
      yield* Effect.forEach(holders, Fiber.join);
      yield* Fiber.join(queued);
      const idle = yield* Metric.snapshot;
      assert.strictEqual(forgeGauge(idle, processGovernorMetricNames.inFlight), 0);
      assert.strictEqual(forgeGauge(idle, processGovernorMetricNames.queued), 0);
    }),
  );

  it.effect("publishes the counts the Promise path changes too", () =>
    Effect.gen(function* () {
      const gauges = Effect.map(Metric.snapshot, (snapshots) => [
        forgeGauge(snapshots, processGovernorMetricNames.inFlight),
        forgeGauge(snapshots, processGovernorMetricNames.queued),
      ]);
      const before = processGovernorStats().find((stats) => stats.pool === "forge")!;
      assert.strictEqual(before.inFlight, 0);
      let finish: () => void = () => undefined;
      const child = governChildProcessPromise(
        "gh",
        "interactive",
        () => new Promise<void>((resolve) => (finish = resolve)),
      );
      yield* Effect.yieldNow;
      assert.deepStrictEqual(yield* gauges, [1, 0]);
      finish();
      yield* Effect.promise(() => child);
      assert.deepStrictEqual(yield* gauges, [0, 0]);
    }),
  );

  it.effect("returns the permit when a queued child is interrupted", () =>
    Effect.gen(function* () {
      const limit = processGovernorStats().find((stats) => stats.pool === "forge")?.limit ?? 4;
      const release = yield* Deferred.make<void>();
      const holders = yield* Effect.forEach(Array.from({ length: limit }), () =>
        governChildProcess("gh", Deferred.await(release)).pipe(Effect.forkChild),
      );
      yield* Effect.yieldNow;
      const queued = yield* governChildProcess("gh", Effect.void).pipe(
        inBackgroundProcessLane,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(queued);
      yield* Deferred.succeed(release, undefined);
      yield* Effect.forEach(holders, Fiber.join);
      assert.include(
        processGovernorStats().find((stats) => stats.pool === "forge"),
        {
          inFlight: 0,
          queued: 0,
        },
      );
    }),
  );
});
