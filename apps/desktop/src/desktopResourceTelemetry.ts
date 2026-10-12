import type { Duplex } from "node:stream";
import { app, powerMonitor } from "electron";
import {
  createTelemetryLineReader,
  type DesktopBackendLifecycleFrame,
  type DesktopResourceTelemetrySnapshot,
  parseDesktopBackendLifecycleFrame,
} from "@ryco/shared/desktopResourceTelemetry";

/**
 * Attached to one backend generation; closed pipes remove all listeners.
 * Besides answering `sample` requests, the pipe carries the backend's lifecycle
 * frames (readiness, startup phases, fatal errors). They are validated with the
 * shared protocol parser the backend writes against and handed to `onFrame`;
 * anything else is ignored.
 */
export function attachDesktopResourceTelemetry(
  pipe: Duplex,
  onFrame?: (frame: DesktopBackendLifecycleFrame) => void,
): () => void {
  let suspended = false;
  let locked: boolean | null = null;
  let speedLimitPercent: number | null = null;
  let closed = false;
  let blocked = false;
  let lastSampleAt = 0;
  const send = (includeProcesses: boolean) => {
    if (closed || blocked || pipe.destroyed) return;
    try {
      const snapshot: DesktopResourceTelemetrySnapshot = {
        sampledAt: new Date().toISOString(),
        processSample: includeProcesses,
        electronPid: process.pid,
        power: {
          idleState: powerMonitor.getSystemIdleState(60),
          idleSeconds: powerMonitor.getSystemIdleTime(),
          onBattery: powerMonitor.isOnBatteryPower(),
          thermalState: powerMonitor.getCurrentThermalState(),
          speedLimitPercent,
          suspended,
          locked,
          lowPowerMode: null,
          updatedAt: new Date().toISOString(),
          stale: false,
        },
        processes: includeProcesses
          ? app
              .getAppMetrics()
              .slice(0, 512)
              .map((entry) => ({
                pid: entry.pid,
                startTimeMs: entry.creationTime,
                type: entry.type,
                cpuPercent: Math.max(0, entry.cpu.percentCPUUsage),
                cpuTimeMs: Math.max(0, (entry.cpu.cumulativeCPUUsage ?? 0) * 1000),
                residentBytes: entry.memory.workingSetSize * 1024,
                privateBytes: (entry.memory.privateBytes ?? 0) * 1024,
                idleWakeupsPerSecond: Math.max(0, entry.cpu.idleWakeupsPerSecond),
              }))
          : [],
      };
      blocked = !pipe.write(`${JSON.stringify(snapshot)}\n`);
    } catch {
      // Unsupported host metrics cannot interfere with the desktop lifecycle.
    }
  };
  const suspend = () => {
    suspended = true;
    send(false);
  };
  const resume = () => {
    suspended = false;
    send(false);
  };
  const update = () => send(false);
  const lock = () => {
    locked = true;
    send(false);
  };
  const unlock = () => {
    locked = false;
    send(false);
  };
  const speedLimit = (details: { limit: number }) => {
    speedLimitPercent = details.limit;
    send(false);
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    powerMonitor.removeListener("suspend", suspend);
    powerMonitor.removeListener("resume", resume);
    powerMonitor.removeListener("on-ac", update);
    powerMonitor.removeListener("on-battery", update);
    powerMonitor.removeListener("thermal-state-change", update);
    powerMonitor.removeListener("speed-limit-change", speedLimit);
    powerMonitor.removeListener("lock-screen", lock);
    powerMonitor.removeListener("unlock-screen", unlock);
  };
  pipe.setEncoding("utf8");
  pipe.on(
    "data",
    createTelemetryLineReader(
      (value) => {
        if (typeof value !== "object" || value === null || !("type" in value)) return;
        if (value.type !== "sample") {
          const frame = parseDesktopBackendLifecycleFrame(value);
          if (frame !== null) onFrame?.(frame);
          return;
        }
        if (Date.now() - lastSampleAt < 500) return;
        lastSampleAt = Date.now();
        send(true);
      },
      () => pipe.destroy(),
    ),
  );
  pipe.on("drain", () => {
    blocked = false;
  });
  pipe.on("error", cleanup);
  pipe.on("close", cleanup);
  powerMonitor.on("suspend", suspend);
  powerMonitor.on("resume", resume);
  powerMonitor.on("on-ac", update);
  powerMonitor.on("on-battery", update);
  powerMonitor.on("thermal-state-change", update);
  powerMonitor.on("speed-limit-change", speedLimit);
  powerMonitor.on("lock-screen", lock);
  powerMonitor.on("unlock-screen", unlock);
  const heartbeat = setInterval(update, 30_000);
  heartbeat.unref();
  send(false);
  return cleanup;
}
