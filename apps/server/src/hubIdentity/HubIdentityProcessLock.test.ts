import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { makeHubIdentityProcessLock } from "./HubIdentityProcessLock.ts";

const BOOT = 1_784_000_000_000;

async function lockPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "ryco-hub-lock-")), "hub-connector.lock");
}

const lockFor = (path: string, pid: number, alive: ReadonlySet<number>, bootTime = BOOT) =>
  makeHubIdentityProcessLock({
    path,
    pid,
    bootTime: () => bootTime,
    processAlive: (candidate) => alive.has(candidate),
  });

describe("Hub identity process lock", () => {
  it("lets exactly one live process hold an identity", async () => {
    const path = await lockPath();
    const alive = new Set([100, 200]);
    const first = lockFor(path, 100, alive);
    const second = lockFor(path, 200, alive);

    await expect(first.acquire()).resolves.toBe("acquired");
    await expect(first.acquire()).resolves.toBe("acquired");
    await expect(second.acquire()).resolves.toBe("held");
    expect(await readFile(path, "utf8")).toBe(`100 ${BOOT}\n`);

    // Stopping the first hands the identity to the second on its next check.
    await first.release();
    await expect(second.acquire()).resolves.toBe("acquired");
    expect(await readFile(path, "utf8")).toBe(`200 ${BOOT}\n`);
  });

  it("reclaims a lock whose holder died without releasing it", async () => {
    const path = await lockPath();
    await writeFile(path, `100 ${BOOT}\n`, { mode: 0o600 });
    const next = lockFor(path, 200, new Set([200]));
    await expect(next.acquire()).resolves.toBe("acquired");
    expect(await readFile(path, "utf8")).toBe(`200 ${BOOT}\n`);
  });

  it("reclaims a lock from an earlier boot even when its pid was reused", async () => {
    const path = await lockPath();
    // Power was lost; after the reboot an unrelated process got pid 100.
    await writeFile(path, `100 ${BOOT - 3_600_000}\n`, { mode: 0o600 });
    const next = lockFor(path, 200, new Set([100, 200]));
    await expect(next.acquire()).resolves.toBe("acquired");
  });

  it("does not mistake a wall-clock correction for a reboot", async () => {
    const path = await lockPath();
    await writeFile(path, `100 ${BOOT - 90_000}\n`, { mode: 0o600 });
    const next = lockFor(path, 200, new Set([100, 200]));
    await expect(next.acquire()).resolves.toBe("held");
  });

  it("waits out a lock being written and reclaims one a crash left half-written", async () => {
    const path = await lockPath();
    await writeFile(path, "", { mode: 0o600 });
    const next = lockFor(path, 200, new Set([200]));
    await expect(next.acquire()).resolves.toBe("held");

    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(path, old, old);
    await expect(next.acquire()).resolves.toBe("acquired");
  });

  it("never removes a lock it does not hold", async () => {
    const path = await lockPath();
    const alive = new Set([100, 200]);
    const holder = lockFor(path, 100, alive);
    const other = lockFor(path, 200, alive);
    await holder.acquire();
    await expect(other.acquire()).resolves.toBe("held");
    await other.release();
    expect(await readFile(path, "utf8")).toBe(`100 ${BOOT}\n`);
  });

  it("reports an unusable lock location instead of failing the connector", async () => {
    const lock = makeHubIdentityProcessLock({
      path: join(await lockPath(), "missing-directory", "hub-connector.lock"),
    });
    await expect(lock.acquire()).resolves.toBe("unavailable");
  });
});
