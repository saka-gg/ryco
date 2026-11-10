import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  orderSavedEnvironmentConnectionQueue,
  runSavedEnvironmentConnectionQueue,
} from "./savedEnvironmentConnectionScheduler.ts";

describe("savedEnvironmentConnectionScheduler", () => {
  it("prioritizes explicit ids, then most recently connected records", () => {
    const records = [
      {
        environmentId: EnvironmentId.make("b"),
        lastConnectedAt: "2026-05-10T00:00:00.000Z",
      },
      {
        environmentId: EnvironmentId.make("a"),
        lastConnectedAt: "2026-05-12T00:00:00.000Z",
      },
      {
        environmentId: EnvironmentId.make("c"),
        lastConnectedAt: "2026-05-11T00:00:00.000Z",
      },
    ];

    expect(
      orderSavedEnvironmentConnectionQueue(records, new Set([EnvironmentId.make("b")])).map(
        (record) => record.environmentId,
      ),
    ).toEqual(["b", "a", "c"]);
  });

  it("runs connection work with a concurrency cap", async () => {
    const started: number[] = [];
    const completed: number[] = [];
    let active = 0;
    let maxActive = 0;
    const release: Array<() => void> = [];

    const records = [1, 2, 3].map((index) => ({
      environmentId: EnvironmentId.make(`env-${index}`),
      index,
    }));
    const running = runSavedEnvironmentConnectionQueue(records, {
      concurrency: 2,
      connect: async ({ index: item }) => {
        started.push(item);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => release.push(resolve));
        active -= 1;
        completed.push(item);
      },
    });

    await Promise.resolve();
    expect(started).toEqual([1, 2]);
    expect(maxActive).toBe(2);

    release.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([1, 2, 3]);

    release.shift()?.();
    release.shift()?.();
    await running;

    expect(completed.toSorted()).toEqual([1, 2, 3]);
  });

  it("gives a free slot to a machine the user started looking at while the queue ran", async () => {
    const env = (id: string) => EnvironmentId.make(id);
    const started: string[] = [];
    const release: Array<() => void> = [];
    const priority = new Set<EnvironmentId>();
    const running = runSavedEnvironmentConnectionQueue(
      ["asleep-1", "asleep-2", "other", "viewed"].map((id) => ({ environmentId: env(id) })),
      {
        concurrency: 2,
        readPriority: () => priority,
        connect: async (record) => {
          started.push(record.environmentId);
          await new Promise<void>((resolve) => release.push(resolve));
        },
      },
    );
    await Promise.resolve();
    expect(started).toEqual(["asleep-1", "asleep-2"]);
    priority.add(env("viewed"));
    release.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["asleep-1", "asleep-2", "viewed"]);
    for (const next of [...release, ...release]) next();
    while (release.length > 0) {
      release.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await running;
    expect(started).toEqual(["asleep-1", "asleep-2", "viewed", "other"]);
  });
});
