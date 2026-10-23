import { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { makeDesktopResourceTelemetry } from "./DesktopResourceTelemetry.ts";

const snapshot = {
  sampledAt: "2026-09-07T12:00:00.000Z",
  processSample: true,
  electronPid: 12,
  power: {
    idleState: "active",
    idleSeconds: 0,
    onBattery: false,
    thermalState: "nominal",
    speedLimitPercent: null,
    suspended: false,
    locked: null,
    lowPowerMode: null,
    updatedAt: "2026-09-07T12:00:00.000Z",
    stale: false,
  },
  processes: [
    {
      pid: 12,
      startTimeMs: 100,
      type: "Browser",
      cpuPercent: 120,
      cpuTimeMs: 20,
      residentBytes: 1000,
      privateBytes: 0,
      idleWakeupsPerSecond: 3,
    },
  ],
};
afterEach(() => vi.useRealTimers());

describe("desktop resource telemetry receiver", () => {
  it("does not let unsolicited power frames complete or erase a process sample", async () => {
    vi.useFakeTimers();
    const pipe = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const receiver = makeDesktopResourceTelemetry(pipe);
    const read = receiver.read();
    let completed = false;
    void read.then(() => {
      completed = true;
    });
    pipe.emit("data", `${JSON.stringify({ ...snapshot, processSample: false, processes: [] })}\n`);
    await Promise.resolve();
    expect(completed).toBe(false);
    pipe.emit("data", `${JSON.stringify(snapshot)}\n`);
    expect((await read)?.processes).toHaveLength(1);
    pipe.emit(
      "data",
      `${JSON.stringify({ ...snapshot, processSample: false, processes: [], power: { ...snapshot.power, locked: true } })}\n`,
    );
    const second = receiver.read();
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await second)?.processes).toHaveLength(1);
    expect((await second)?.power.locked).toBe(true);
    await vi.advanceTimersByTimeAsync(11_000);
    const stale = receiver.read();
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await stale)?.processes).toEqual([]);
    pipe.destroy();
  });
  it("keeps the pipe open over malformed input: its close shuts the backend down", async () => {
    const pipe = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const receiver = makeDesktopResourceTelemetry(pipe);
    const read = receiver.read();
    pipe.emit("data", `not json\n${JSON.stringify(snapshot)}\n`);
    expect(pipe.destroyed).toBe(false);
    expect((await read)?.processes).toHaveLength(1);
    pipe.emit("data", "x".repeat(300 * 1024));
    expect(pipe.destroyed).toBe(false);
    pipe.destroy();
  });
  it("coalesces pending requests and closes cleanly", async () => {
    const pipe = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const receiver = makeDesktopResourceTelemetry(pipe);
    const first = receiver.read();
    expect(receiver.read()).toBe(first);
    pipe.destroy();
    expect(await first).toBeNull();
  });
});
