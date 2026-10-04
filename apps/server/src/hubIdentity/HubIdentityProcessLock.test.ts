import { access, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { makeHubIdentityProcessLock } from "./HubIdentityProcessLock.ts";

const BOOT = 1_784_000_000_000;

async function lockPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "ryco-hub-lock-")), "hub-connector.lock");
}

const BOOT_ID = "0b6ff1d4-6c1f-4f5e-9d38-6a1c3e2b7f10";
const OTHER_BOOT_ID = "9a2e7c41-0d5b-4b8e-a3f6-2c7d9e1f4b52";

const lockFor = (
  path: string,
  pid: number,
  alive: ReadonlySet<number>,
  options: {
    readonly bootTime?: number;
    readonly bootId?: string;
    readonly startTimes?: ReadonlyMap<number, string>;
  } = {},
) =>
  makeHubIdentityProcessLock({
    path,
    pid,
    bootTime: () => options.bootTime ?? BOOT,
    bootId: async () => options.bootId,
    processStartTime: async (candidate) => options.startTimes?.get(candidate),
    processAlive: (candidate) => alive.has(candidate),
  });

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe("Hub identity process lock", () => {
  it("lets exactly one live process hold an identity", async () => {
    const path = await lockPath();
    const alive = new Set([100, 200]);
    const first = lockFor(path, 100, alive);
    const second = lockFor(path, 200, alive);

    await expect(first.acquire()).resolves.toBe("acquired");
    await expect(first.acquire()).resolves.toBe("acquired");
    await expect(second.acquire()).resolves.toBe("held");
    expect(await readFile(path, "utf8")).toBe(`100 ${BOOT} - -\n`);

    // Stopping the first hands the identity to the second on its next check.
    await first.release();
    await expect(second.acquire()).resolves.toBe("acquired");
    expect(await readFile(path, "utf8")).toBe(`200 ${BOOT} - -\n`);
  });

  it("reclaims a lock whose holder died without releasing it", async () => {
    const path = await lockPath();
    await writeFile(path, `100 ${BOOT}\n`, { mode: 0o600 });
    const next = lockFor(path, 200, new Set([200]));
    await expect(next.acquire()).resolves.toBe("acquired");
    expect(await readFile(path, "utf8")).toBe(`200 ${BOOT} - -\n`);
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
    expect(await readFile(path, "utf8")).toBe(`100 ${BOOT} - -\n`);
  });

  it("trusts the kernel's boot id over a wall clock corrected after the holder started", async () => {
    const path = await lockPath();
    // A board without a real-time clock whose network time sync landed an hour
    // after the holder wrote its boot-time estimate.
    await writeFile(path, `100 ${BOOT - 3_600_000} ${BOOT_ID} -\n`, { mode: 0o600 });
    const next = lockFor(path, 200, new Set([100, 200]), { bootId: BOOT_ID });
    await expect(next.acquire()).resolves.toBe("held");
  });

  it("reclaims a lock from an earlier boot by its boot id", async () => {
    const path = await lockPath();
    await writeFile(path, `100 ${BOOT} ${OTHER_BOOT_ID} -\n`, { mode: 0o600 });
    const next = lockFor(path, 200, new Set([100, 200]), { bootId: BOOT_ID });
    await expect(next.acquire()).resolves.toBe("acquired");
    expect(await readFile(path, "utf8")).toBe(`200 ${BOOT} ${BOOT_ID} -\n`);
  });

  it("tells a reused pid from the holder by when it started", async () => {
    const path = await lockPath();
    const holder = lockFor(path, 100, new Set([100, 200]), {
      bootId: BOOT_ID,
      startTimes: new Map([[100, "5000"]]),
    });
    await expect(holder.acquire()).resolves.toBe("acquired");
    expect(await readFile(path, "utf8")).toBe(`100 ${BOOT} ${BOOT_ID} 5000\n`);
    // Still the process that wrote it.
    await expect(
      lockFor(path, 200, new Set([100, 200]), {
        bootId: BOOT_ID,
        startTimes: new Map([[100, "5000"]]),
      }).acquire(),
    ).resolves.toBe("held");
    // After a container restart pid 100 is one of the new server's children.
    await expect(
      lockFor(path, 200, new Set([100, 200]), {
        bootId: BOOT_ID,
        startTimes: new Map([[100, "9000"]]),
      }).acquire(),
    ).resolves.toBe("acquired");
  });

  it("shares one attempt between racing callers, and lets a release win over it", async () => {
    const path = await lockPath();
    const alive = new Set([100, 200]);
    const lock = lockFor(path, 100, alive);
    await expect(Promise.all([lock.acquire(), lock.acquire()])).resolves.toEqual([
      "acquired",
      "acquired",
    ]);
    await expect(lockFor(path, 200, alive).acquire()).resolves.toBe("held");

    await lock.release();
    const acquiring = lock.acquire();
    await lock.release();
    await expect(acquiring).resolves.toBe("acquired");
    expect(await exists(path)).toBe(false);
  });

  it("reports an unusable lock location instead of failing the connector", async () => {
    const lock = makeHubIdentityProcessLock({
      path: join(await lockPath(), "missing-directory", "hub-connector.lock"),
    });
    await expect(lock.acquire()).resolves.toBe("unavailable");
  });
});
