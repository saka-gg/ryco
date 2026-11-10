import { describe, expect, it, vi } from "vite-plus/test";

import { createAppBadge } from "./appBadge";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function nativeStore() {
  // What the push extension and the app share: each machine's last known count.
  const stored = new Map<string, number>();
  return {
    stored,
    setBadgeCounts: vi.fn(
      async (live: Readonly<Record<string, number>>, listed: ReadonlyArray<string>) => {
        for (const id of stored.keys()) if (!listed.includes(id)) stored.delete(id);
        for (const [id, count] of Object.entries(live)) stored.set(id, count);
        return [...stored.values()].reduce((sum, count) => sum + count, 0);
      },
    ),
    clearBadge: vi.fn(async () => {
      stored.clear();
    }),
  };
}

describe("the app badge", () => {
  it("writes live counts over what alerts brought, and only when they change", async () => {
    const native = nativeStore();
    // An alert from the Mac mini set its count while the app was closed.
    native.stored.set("env-mini", 2);
    const badge = createAppBadge({ native, setBadgeCount: vi.fn(async () => true) });

    badge.update({ live: new Map([["env-mac", 1]]), listed: ["env-mac", "env-mini"] });
    badge.update({ live: new Map([["env-mac", 1]]), listed: ["env-mini", "env-mac"] });
    await settle();
    expect(native.setBadgeCounts).toHaveBeenCalledTimes(1);
    // The Mac mini is not live yet: its alert's count stays in the sum.
    expect(await native.setBadgeCounts.mock.results[0]!.value).toBe(3);

    // It connects with nothing waiting, and the Mac's thread is answered.
    badge.update({
      live: new Map([
        ["env-mac", 0],
        ["env-mini", 0],
      ]),
      listed: ["env-mac", "env-mini"],
    });
    await settle();
    expect(await native.setBadgeCounts.mock.results[1]!.value).toBe(0);
  });

  it("drops a machine that was removed, and everything on sign-out", async () => {
    const native = nativeStore();
    native.stored.set("env-old", 4);
    const badge = createAppBadge({ native, setBadgeCount: vi.fn(async () => true) });
    badge.update({ live: new Map([["env-mac", 1]]), listed: ["env-mac"] });
    await settle();
    expect([...native.stored]).toEqual([["env-mac", 1]]);

    await badge.clear();
    expect(native.clearBadge).toHaveBeenCalledTimes(1);
    expect(native.stored.size).toBe(0);
    // After a clear the same counts are written again.
    badge.update({ live: new Map([["env-mac", 1]]), listed: ["env-mac"] });
    await settle();
    expect(native.setBadgeCounts).toHaveBeenCalledTimes(2);
  });

  it("sets the plain badge from the live counts in a build without the shared store", async () => {
    const setBadgeCount = vi.fn(async (_count: number) => true);
    const badge = createAppBadge({ native: null, setBadgeCount });
    badge.update({
      live: new Map([
        ["env-a", 2],
        ["env-b", 1],
      ]),
      listed: ["env-a", "env-b"],
    });
    await badge.clear();
    expect(setBadgeCount.mock.calls).toEqual([[3], [0]]);
  });

  it("writes again after a failed write", async () => {
    const native = nativeStore();
    native.setBadgeCounts.mockRejectedValueOnce(new Error("keychain"));
    const onError = vi.fn();
    const badge = createAppBadge({ native, setBadgeCount: vi.fn(async () => true), onError });
    const counts = { live: new Map([["env-mac", 1]]), listed: ["env-mac"] };
    badge.update(counts);
    await settle();
    expect(onError).toHaveBeenCalledTimes(1);
    badge.update(counts);
    await settle();
    expect(native.setBadgeCounts).toHaveBeenCalledTimes(2);
  });
});
