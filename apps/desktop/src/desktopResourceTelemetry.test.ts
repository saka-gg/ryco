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
import type { DesktopUpdateState } from "@ryco/contracts";
import {
  type DesktopAppUpdateRequestFrame,
  type DesktopBackendLifecycleFrame,
  parseDesktopAppUpdateStateFrame,
} from "@ryco/shared/desktopResourceTelemetry";
import { powerMonitor } from "electron";
import { attachDesktopResourceTelemetry } from "./desktopResourceTelemetry.ts";
import { createInitialDesktopUpdateState } from "./updateMachine.ts";

const updateState: DesktopUpdateState = {
  ...createInitialDesktopUpdateState("1.0.0", "latest"),
  enabled: true,
  status: "idle",
};

/** A backend pipe that records what the app writes; `hold` keeps writes unacknowledged. */
function backendPipe(options: { hold?: boolean } = {}) {
  const written: string[] = [];
  const held: Array<() => void> = [];
  const pipe = new Duplex({
    read() {},
    ...(options.hold ? { writableHighWaterMark: 1 } : {}),
    write(chunk, _encoding, callback) {
      written.push(String(chunk));
      if (options.hold) held.push(callback);
      else callback();
    },
  });
  return {
    pipe,
    appUpdateFrames: () =>
      written
        .map((line) => JSON.parse(line) as { type?: string })
        .filter((frame) => frame.type === "app-update-state"),
    release: () => {
      for (const callback of held.splice(0)) callback();
    },
  };
}

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
    stop.close();
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
    const stop = attachDesktopResourceTelemetry(pipe, {
      onLifecycleFrame: (frame) => frames.push(frame),
    });
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
    stop.close();
    pipe.destroy();
  });

  it("hands valid app update requests to the owner, even after a handler throws", () => {
    const { pipe } = backendPipe();
    const requests: DesktopAppUpdateRequestFrame[] = [];
    const lifecycle: DesktopBackendLifecycleFrame[] = [];
    const stop = attachDesktopResourceTelemetry(pipe, {
      onLifecycleFrame: (frame) => lifecycle.push(frame),
      onAppUpdateRequest: (frame) => {
        requests.push(frame);
        if (requests.length === 1) throw new Error("updater exploded");
      },
    });
    pipe.emit(
      "data",
      [
        '{"type":"app-update-check"}',
        '{"type":"app-update-install","requestId":"req-1","targetVersion":"1.1.0"}',
        '{"type":"app-update-install","requestId":"","targetVersion":"1.1.0"}',
        '{"type":"app-update-install","targetVersion":"1.1.0"}',
        '{"type":"startup-ready"}',
        "",
      ].join("\n"),
    );
    expect(requests).toEqual([
      { type: "app-update-check" },
      { type: "app-update-install", requestId: "req-1", targetVersion: "1.1.0" },
    ]);
    expect(lifecycle).toEqual([{ type: "startup-ready" }]);
    expect(pipe.destroyed).toBe(false);
    stop.close();
    pipe.destroy();
  });

  it("reports the updater state on attach and again only when it changes", () => {
    const { pipe, appUpdateFrames } = backendPipe();
    const stop = attachDesktopResourceTelemetry(pipe, { appUpdateState: () => updateState });
    expect(appUpdateFrames()).toEqual([
      {
        type: "app-update-state",
        state: {
          enabled: true,
          status: "idle",
          channel: "latest",
          currentVersion: "1.0.0",
          availableVersion: null,
          downloadedVersion: null,
          downloadPercent: null,
          checkedAt: null,
          message: null,
          remoteInstall: null,
        },
      },
    ]);

    stop.sendAppUpdateState(updateState);
    stop.sendAppUpdateState({ ...updateState, canRetry: true });
    expect(appUpdateFrames()).toHaveLength(1);

    const countdown: DesktopUpdateState = {
      ...updateState,
      status: "downloaded",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      downloadPercent: 100,
      remoteInstall: {
        requestId: "req-1",
        targetVersion: "1.1.0",
        phase: "countdown",
        restartAt: "2026-10-21T10:00:30.000Z",
        message: null,
      },
    };
    stop.sendAppUpdateState(countdown);
    stop.sendAppUpdateState(countdown, { force: true });
    stop.sendAppUpdateState({ ...countdown, status: "error", message: "x".repeat(300_000) });
    const frames = appUpdateFrames();
    expect(frames).toHaveLength(4);
    // What the backend's parser accepts is exactly what the app sent.
    expect(parseDesktopAppUpdateStateFrame(frames[1])).toEqual(frames[1]);
    expect(parseDesktopAppUpdateStateFrame(frames[3])).toEqual(frames[3]);

    stop.close();
    stop.sendAppUpdateState(updateState);
    expect(appUpdateFrames()).toHaveLength(4);
    pipe.destroy();
  });

  it("holds only the newest report while the pipe is blocked and sends it on drain", async () => {
    const { pipe, appUpdateFrames, release } = backendPipe({ hold: true });
    // The attach-time power sample fills the pipe; the attach-time report has to wait.
    const stop = attachDesktopResourceTelemetry(pipe, { appUpdateState: () => updateState });
    expect(appUpdateFrames()).toHaveLength(0);

    stop.sendAppUpdateState({ ...updateState, status: "checking" });
    stop.sendAppUpdateState({ ...updateState, status: "available", availableVersion: "1.1.0" });
    expect(appUpdateFrames()).toHaveLength(0);

    release();
    await new Promise((resolve) => setImmediate(resolve));

    expect(appUpdateFrames()).toEqual([
      expect.objectContaining({
        state: expect.objectContaining({ status: "available", availableVersion: "1.1.0" }),
      }),
    ]);
    stop.close();
    pipe.destroy();
  });
});
