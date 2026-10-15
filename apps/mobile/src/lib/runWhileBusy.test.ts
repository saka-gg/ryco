import { describe, expect, it } from "vite-plus/test";

import { runThenSettle, runWhileBusy } from "./runWhileBusy";

describe("runWhileBusy", () => {
  it("holds the busy flag for the task and returns its value", async () => {
    const busy: Array<boolean> = [];
    const seenWhileRunning: Array<ReadonlyArray<boolean>> = [];

    const result = await runWhileBusy(
      (next) => busy.push(next),
      async () => {
        seenWhileRunning.push([...busy]);
        return "sent";
      },
    );

    expect(result).toBe("sent");
    expect(seenWhileRunning).toEqual([[true]]);
    expect(busy).toEqual([true, false]);
  });

  it("clears the busy flag when the task rejects or throws synchronously", async () => {
    const busy: Array<boolean> = [];
    const failure = new Error("offline");

    await expect(
      runWhileBusy(
        (next) => busy.push(next),
        () => Promise.reject(failure),
      ),
    ).rejects.toBe(failure);
    await expect(
      runWhileBusy(
        (next) => busy.push(next),
        () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);

    expect(busy).toEqual([true, false, true, false]);
  });
});

describe("runThenSettle", () => {
  it("settles after the task's own continuation has run", async () => {
    const order: Array<string> = [];

    await runThenSettle(
      async () => {
        await Promise.resolve();
        order.push("task");
      },
      () => order.push("settled"),
    );

    expect(order).toEqual(["task", "settled"]);
  });
});
