import { Duplex } from "node:stream";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const electron = vi.hoisted(() => ({ getAppMetrics: vi.fn() }));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    app: { getAppMetrics: electron.getAppMetrics },
    powerMonitor: Object.assign(new EventEmitter(), {
      getSystemIdleState: () => "active",
      getSystemIdleTime: () => 0,
      isOnBatteryPower: () => false,
      getCurrentThermalState: () => "nominal",
    }),
  };
});
import type { DesktopBackendLifecycleFrame } from "@ryco/shared/desktopResourceTelemetry";
import { powerMonitor } from "electron";
import { attachDesktopResourceTelemetry } from "./desktopResourceTelemetry.ts";

afterEach(() => {
  vi.useRealTimers();
  electron.getAppMetrics.mockReset();
});

describe("desktop resource telemetry", () => {
  it("only samples Electron processes on backend demand and removes listeners on close", () => {
    vi.useFakeTimers();
    const frames: string[] = [];
    const pipe = new Duplex({
      read() {},
      write(chunk, _encoding, callback) {
        frames.push(String(chunk));
        callback();
      },
    });
    electron.getAppMetrics.mockReturnValue([
      {
        pid: 12,
        creationTime: 50,
        type: "Browser",
        cpu: { percentCPUUsage: 120, cumulativeCPUUsage: 2, idleWakeupsPerSecond: 3 },
        memory: { workingSetSize: 20, privateBytes: 10 },
      },
    ]);
    const stop = attachDesktopResourceTelemetry(pipe);
    expect(electron.getAppMetrics).not.toHaveBeenCalled();
    pipe.emit("data", '{"type":"sample"}\n');
    expect(electron.getAppMetrics).toHaveBeenCalledTimes(1);
    const snapshot = JSON.parse(frames.at(-1)!);
    expect(snapshot.processes[0]).toMatchObject({
      cpuPercent: 120,
      cpuTimeMs: 2000,
      residentBytes: 20480,
    });
    vi.advanceTimersByTime(30_000);
    expect(electron.getAppMetrics).toHaveBeenCalledTimes(1);
    expect((powerMonitor as unknown as EventEmitter).listenerCount("suspend")).toBe(1);
    stop();
    expect((powerMonitor as unknown as EventEmitter).listenerCount("suspend")).toBe(0);
    pipe.destroy();
  });

  it("hands valid lifecycle frames to the owner without sampling and drops malformed ones", () => {
    const pipe = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const frames: DesktopBackendLifecycleFrame[] = [];
    const stop = attachDesktopResourceTelemetry(pipe, (frame) => frames.push(frame));
    pipe.emit(
      "data",
      [
        '{"type":"startup-phase","name":"migrations","ms":12}',
        '{"type":"http-serving","port":0}',
        '{"type":"unknown-frame"}',
        '{"type":"http-serving","port":7926}',
        "",
      ].join("\n"),
    );
    expect(frames).toEqual([
      { type: "startup-phase", name: "migrations", ms: 12 },
      { type: "http-serving", port: 7926 },
    ]);
    expect(electron.getAppMetrics).not.toHaveBeenCalled();
    stop();
    pipe.destroy();
  });
});
