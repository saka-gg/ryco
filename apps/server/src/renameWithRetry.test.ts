import { describe, expect, it } from "vite-plus/test";

import { renameWithRetry } from "./renameWithRetry.ts";

const errno = (code: string) => Object.assign(new Error(code), { code });

const harness = (failures: ReadonlyArray<Error>) => {
  const calls: string[] = [];
  const sleeps: number[] = [];
  let index = 0;
  return {
    calls,
    sleeps,
    rename: async (from: string, to: string) => {
      calls.push(`${from}->${to}`);
      const failure = failures[index++];
      if (failure !== undefined) throw failure;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
};

describe("renameWithRetry", () => {
  it("renames once when the first attempt succeeds", async () => {
    const run = harness([]);
    await renameWithRetry("a", "b", { platform: "win32", ...run });
    expect(run.calls).toEqual(["a->b"]);
    expect(run.sleeps).toEqual([]);
  });

  it("retries EPERM and EBUSY on Windows with a doubling pause", async () => {
    const run = harness([errno("EPERM"), errno("EBUSY"), errno("EPERM")]);
    await renameWithRetry("a", "b", { platform: "win32", ...run });
    expect(run.calls).toHaveLength(4);
    expect(run.sleeps).toEqual([100, 200, 400]);
  });

  it("gives up after five attempts and throws the last error", async () => {
    const failures = Array.from({ length: 6 }, () => errno("EBUSY"));
    const run = harness(failures);
    await expect(renameWithRetry("a", "b", { platform: "win32", ...run })).rejects.toBe(
      failures[4],
    );
    expect(run.calls).toHaveLength(5);
    expect(run.sleeps).toEqual([100, 200, 400, 800]);
  });

  it("throws other errors, and every error off Windows, at once", async () => {
    const enoent = errno("ENOENT");
    const windows = harness([enoent]);
    await expect(renameWithRetry("a", "b", { platform: "win32", ...windows })).rejects.toBe(enoent);
    expect(windows.calls).toHaveLength(1);

    const eperm = errno("EPERM");
    const mac = harness([eperm]);
    await expect(renameWithRetry("a", "b", { platform: "darwin", ...mac })).rejects.toBe(eperm);
    expect(mac.calls).toHaveLength(1);
    expect(mac.sleeps).toEqual([]);
  });
});
