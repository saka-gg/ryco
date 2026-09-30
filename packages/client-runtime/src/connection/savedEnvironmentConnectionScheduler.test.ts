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

    const running = runSavedEnvironmentConnectionQueue([1, 2, 3], {
      concurrency: 2,
      connect: async (item) => {
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
});
