import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  decodeNativeSnapshot,
  makeNativeResourceMonitor,
  resolveNativeSampleIntervalMs,
} from "./NativeResourceMonitor.ts";

const snapshot = {
  version: 3,
  type: "snapshot",
  sampledAtUnixMs: 1700000000000,
  collectionDurationMicros: 100,
  scannedProcessCount: 10,
  retainedProcessCount: 1,
  inaccessibleProcessCount: 0,
  processes: [
    {
      pid: 123,
      ppid: 12,
      startTimeMs: 1000,
      runTimeMs: 2000,
      name: "agent",
      command: "agent --token=secret",
      status: "Run",
      cpuPercent: 150,
      cpuTimeMs: 3000,
      residentBytes: 4096,
      virtualBytes: 8192,
      ioReadBytes: 100,
      ioWriteBytes: 200,
      ioSemantics: "storage",
    },
  ],
};

describe("native resource monitor", () => {
  it("validates the protocol and strips argv even from older binaries", () => {
    const decoded = decodeNativeSnapshot(snapshot);
    expect(decoded?.processes[0]?.command).toBe("agent");
    expect(decoded?.processes[0]?.cpuPercent).toBe(150);
    expect(JSON.stringify(decoded)).not.toContain("secret");
    expect(decodeNativeSnapshot({ ...snapshot, version: 2 })).toBeUndefined();
  });

  it("rejects malformed, infinite, negative, and oversized process samples", () => {
    for (const patch of [
      { pid: 0 },
      { cpuPercent: Infinity },
      { residentBytes: -1 },
      { startTimeMs: 1.5 },
      { ioSemantics: "unknown" },
    ]) {
      expect(
        decodeNativeSnapshot({ ...snapshot, processes: [{ ...snapshot.processes[0], ...patch }] }),
      ).toBeUndefined();
    }
    expect(
      decodeNativeSnapshot({ ...snapshot, processes: Array(20001).fill(snapshot.processes[0]) }),
    ).toBeUndefined();
  });

  it("reports missing binaries nonfatally, backs off, and permits explicit retry", async () => {
    let attempts = 0;
    const monitor = makeNativeResourceMonitor({
      resolveBinary: async () => {
        attempts += 1;
        throw new Error("missing");
      },
    });
    await expect(monitor.sample()).rejects.toThrow();
    expect(monitor.health().status).toBe("unavailable");
    await expect(monitor.sample()).rejects.toThrow();
    expect(attempts).toBe(1);
    monitor.retry();
    await expect(monitor.sample()).rejects.toThrow();
    expect(attempts).toBe(2);
    expect(monitor.health().restartCount).toBe(1);
    monitor.close();
    expect(monitor.health().status).toBe("stopped");
  });
});

async function withFakeMonitor(body: string, run: (binary: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ryco-monitor-test-"));
  const binary = path.join(directory, "monitor");
  try {
    await writeFile(binary, `#!${process.execPath}\n${body}`);
    await chmod(binary, 0o700);
    await run(binary);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const respondingSidecar = `
    const snapshot = ${JSON.stringify(snapshot)};
    const write = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    write({ version: 3, type: "hello", sidecarPid: process.pid, sidecarVersion: "test" });
    let buffer = "";
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\\n")) >= 0) {
        const command = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        if (command.type === "sampleNow") write({ ...snapshot, requestId: command.requestId });
        if (command.type === "readHistory") write({ version: 3, type: "historyChunk", requestId: command.requestId, snapshots: [snapshot], done: true });
      }
    });
  `;

it.skipIf(process.platform === "win32")(
  "collects validated snapshots and chunked history and cleans up the subprocess",
  async () => {
    await withFakeMonitor(respondingSidecar, async (binary) => {
      const monitor = makeNativeResourceMonitor({ resolveBinary: async () => binary });
      try {
        const [first, concurrent] = await Promise.all([monitor.sample(), monitor.sample()]);
        expect(first).toBe(concurrent);
        expect(first.processes[0]?.command).toBe("agent");
        expect(await monitor.sample()).toBe(first);
        expect(await monitor.sample({ fresh: true })).not.toBe(first);
        expect(await monitor.history(60000)).toHaveLength(1);
        expect(monitor.health().status).toBe("healthy");
      } finally {
        monitor.close();
      }
      expect(monitor.health().status).toBe("stopped");
    });
  },
);

const isProcessRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

it.skipIf(process.platform === "win32")(
  "stops the sidecar after ten idle minutes and starts it again on demand",
  async () => {
    await withFakeMonitor(respondingSidecar, async (binary) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const monitor = makeNativeResourceMonitor({ resolveBinary: async () => binary });
      try {
        await monitor.sample();
        const firstPid = monitor.health().sidecarPid;
        expect(monitor.health().status).toBe("healthy");
        expect(firstPid).toBeDefined();

        // A request restarts the idle countdown.
        vi.advanceTimersByTime(9 * 60_000);
        await monitor.sample({ fresh: true });
        vi.advanceTimersByTime(9 * 60_000);
        expect(monitor.health().status).toBe("healthy");

        vi.advanceTimersByTime(60_000);
        expect(monitor.health().status).toBe("stopped");
        expect(monitor.health().sidecarPid).toBeUndefined();
        for (let attempt = 0; attempt < 100 && isProcessRunning(firstPid!); attempt += 1) {
          await sleep(20);
        }
        expect(isProcessRunning(firstPid!)).toBe(false);

        const restarted = await monitor.sample();
        expect(restarted.processes[0]?.command).toBe("agent");
        expect(monitor.health().status).toBe("healthy");
        expect(monitor.health().sidecarPid).not.toBe(firstPid);
        expect(monitor.health().restartCount).toBe(0);
      } finally {
        monitor.close();
        vi.useRealTimers();
      }
    });
  },
);

it.skipIf(process.platform === "win32")("fails closed on malformed sidecar output", async () => {
  await withFakeMonitor(
    'process.stdout.write("bad-json\\n"); setInterval(() => {}, 1000);',
    async (binary) => {
      const monitor = makeNativeResourceMonitor({ resolveBinary: async () => binary });
      try {
        await expect(monitor.sample()).rejects.toThrow("invalid JSON");
        expect(monitor.health().status).toBe("unavailable");
      } finally {
        monitor.close();
      }
    },
  );
});

it.skipIf(process.platform === "win32")(
  "cancels startup and ignores the superseded child's exit",
  async () => {
    await withFakeMonitor("setInterval(() => {}, 1000);", async (binary) => {
      const monitor = makeNativeResourceMonitor({ resolveBinary: async () => binary });
      const sampling = monitor.sample();
      const rejection = expect(sampling).rejects.toThrow("stopped");
      await new Promise((resolve) => setTimeout(resolve, 30));
      monitor.close();
      await rejection;
      expect(monitor.health().status).toBe("stopped");
    });
  },
);

it("reduces sampling for background, battery and constrained hosts", () => {
  const power = {
    stale: false,
    suspended: false,
    locked: false,
    lowPowerMode: false,
    onBattery: false,
    thermalState: "nominal",
  };
  expect(resolveNativeSampleIntervalMs(null, true)).toBe(1000);
  expect(resolveNativeSampleIntervalMs(power, false)).toBe(5000);
  expect(resolveNativeSampleIntervalMs({ ...power, onBattery: true }, true)).toBe(5000);
  for (const constrained of [
    { locked: true },
    { lowPowerMode: true },
    { suspended: true },
    { thermalState: "serious" },
    { thermalState: "critical" },
  ]) {
    expect(resolveNativeSampleIntervalMs({ ...power, ...constrained }, true)).toBe(15000);
  }
  expect(resolveNativeSampleIntervalMs({ ...power, stale: true, onBattery: true }, true)).toBe(
    1000,
  );
});

it("power updates do not launch a sidecar", () => {
  let launches = 0;
  const monitor = makeNativeResourceMonitor({
    resolveBinary: async () => {
      launches += 1;
      throw new Error("unexpected");
    },
  });
  monitor.setHostPowerState({
    stale: false,
    suspended: true,
    locked: null,
    lowPowerMode: null,
    onBattery: true,
    thermalState: "unknown",
  });
  expect(launches).toBe(0);
  expect(monitor.health().status).toBe("stopped");
  monitor.close();
});
