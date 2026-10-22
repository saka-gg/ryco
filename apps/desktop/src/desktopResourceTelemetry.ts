import type { Duplex } from "node:stream";
import { app, powerMonitor } from "electron";
import type { DesktopUpdateState } from "@ryco/contracts";
import {
  createTelemetryLineReader,
  type DesktopAppUpdateRequestFrame,
  type DesktopAppUpdateSnapshot,
  type DesktopAppUpdateStateFrame,
  type DesktopBackendLifecycleFrame,
  type DesktopResourceTelemetrySnapshot,
  parseDesktopAppUpdateRequestFrame,
  parseDesktopBackendLifecycleFrame,
} from "@ryco/shared/desktopResourceTelemetry";

export interface DesktopBackendPipeHandlers {
  /** Readiness, startup phases and fatal errors of this backend generation. */
  readonly onLifecycleFrame?: (frame: DesktopBackendLifecycleFrame) => void;
  /** A client's app update check or install request, relayed by the backend. */
  readonly onAppUpdateRequest?: (frame: DesktopAppUpdateRequestFrame) => void;
  /** The updater's state now; reported once when the pipe attaches. */
  readonly appUpdateState?: () => DesktopUpdateState;
}

export interface DesktopBackendPipe {
  /**
   * Report the updater's state to the backend. A report equal to the last one is
   * dropped unless `force` is set; while the pipe is blocked only the newest report
   * waits for `drain`.
   */
  readonly sendAppUpdateState: (state: DesktopUpdateState, options?: { force?: boolean }) => void;
  /**
   * Detach: stop the heartbeat and remove every listener. The pipe stays open:
   * the backend takes its close for the app's exit and shuts down.
   */
  readonly close: () => void;
}

/**
 * The backend keeps at most this much of a message; an updater error can carry a whole
 * HTTP response, and an oversized line would make the backend's reader drop the pipe.
 */
const APP_UPDATE_MESSAGE_MAX_LENGTH = 4_096;

/** The part of the updater state the backend reports to clients. */
export function toDesktopAppUpdateSnapshot(state: DesktopUpdateState): DesktopAppUpdateSnapshot {
  return {
    enabled: state.enabled,
    status: state.status,
    channel: state.channel,
    currentVersion: state.currentVersion,
    availableVersion: state.availableVersion,
    downloadedVersion: state.downloadedVersion,
    downloadPercent: state.downloadPercent,
    checkedAt: state.checkedAt,
    message: state.message === null ? null : state.message.slice(0, APP_UPDATE_MESSAGE_MAX_LENGTH),
    remoteInstall: state.remoteInstall ?? null,
  };
}

/**
 * Attached to one backend generation; closed pipes remove all listeners.
 * Besides answering `sample` requests, the pipe carries the backend's lifecycle
 * frames (readiness, startup phases, fatal errors) and relayed app update
 * requests. Both are validated with the shared protocol parsers the backend
 * writes against and handed to their handler; anything else is ignored. In the
 * other direction the app reports its updater state (`app-update-state`) on
 * attach and through {@link DesktopBackendPipe.sendAppUpdateState}.
 */
export function attachDesktopResourceTelemetry(
  pipe: Duplex,
  handlers: DesktopBackendPipeHandlers = {},
): DesktopBackendPipe {
  let suspended = false;
  let locked: boolean | null = null;
  let speedLimitPercent: number | null = null;
  let closed = false;
  let blocked = false;
  let lastSampleAt = 0;
  // The last app update report written, and the newest one held back while blocked.
  let lastAppUpdateLine: string | null = null;
  let pendingAppUpdateLine: string | null = null;
  const write = (line: string) => {
    blocked = !pipe.write(line);
  };
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
      write(`${JSON.stringify(snapshot)}\n`);
    } catch {
      // Unsupported host metrics cannot interfere with the desktop lifecycle.
    }
  };
  const sendAppUpdateState = (state: DesktopUpdateState, options?: { force?: boolean }) => {
    if (closed || pipe.destroyed) return;
    try {
      const frame: DesktopAppUpdateStateFrame = {
        type: "app-update-state",
        state: toDesktopAppUpdateSnapshot(state),
      };
      const line = `${JSON.stringify(frame)}\n`;
      if (options?.force !== true && line === (pendingAppUpdateLine ?? lastAppUpdateLine)) return;
      if (blocked) {
        pendingAppUpdateLine = line;
        return;
      }
      pendingAppUpdateLine = null;
      lastAppUpdateLine = line;
      write(line);
    } catch {
      // A pipe that cannot take the report must not break the updater.
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
    pendingAppUpdateLine = null;
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
        if (value.type === "app-update-check" || value.type === "app-update-install") {
          const request = parseDesktopAppUpdateRequestFrame(value);
          if (request === null) return;
          try {
            handlers.onAppUpdateRequest?.(request);
          } catch {
            // The updater owns its failures; a throw here would tear down the pipe.
          }
          return;
        }
        if (value.type !== "sample") {
          const frame = parseDesktopBackendLifecycleFrame(value);
          if (frame !== null) handlers.onLifecycleFrame?.(frame);
          return;
        }
        if (Date.now() - lastSampleAt < 500) return;
        lastSampleAt = Date.now();
        send(true);
      },
      // A malformed line is dropped. Closing the pipe over it would stop a
      // backend this app still wants: the backend takes the close for its exit.
      () => undefined,
    ),
  );
  pipe.on("drain", () => {
    blocked = false;
    const pending = pendingAppUpdateLine;
    if (closed || pending === null || pipe.destroyed) return;
    pendingAppUpdateLine = null;
    lastAppUpdateLine = pending;
    try {
      write(pending);
    } catch {
      // See sendAppUpdateState.
    }
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
  if (handlers.appUpdateState !== undefined) {
    try {
      sendAppUpdateState(handlers.appUpdateState());
    } catch {
      // See sendAppUpdateState.
    }
  }
  return { sendAppUpdateState, close: cleanup };
}
