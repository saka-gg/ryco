import {
  attachDesktopAppUpdateChannel,
  detachDesktopAppUpdateChannel,
  receiveDesktopAppUpdateSnapshot,
} from "../desktopAppUpdateBridge.ts";
import { attachDesktopLifecycleChannel } from "../desktopLifecycle.ts";
import { watchDesktopParentPipe } from "../desktopParentLifetime.ts";
import { nativeResourceMonitor } from "./NativeResourceMonitor.ts";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import {
  createTelemetryLineReader,
  DESKTOP_TELEMETRY_STALE_MS,
  parseDesktopAppUpdateStateFrame,
  parseDesktopResourceTelemetry,
  type DesktopResourceTelemetrySnapshot,
} from "@ryco/shared/desktopResourceTelemetry";

export type { DesktopResourceTelemetrySnapshot } from "@ryco/shared/desktopResourceTelemetry";

export function makeDesktopResourceTelemetry(connection: Duplex) {
  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  let latest: DesktopResourceTelemetrySnapshot | null = null;
  let powerReceivedAt = 0;
  let processReceivedAt = 0;
  let pending: Promise<DesktopResourceTelemetrySnapshot | null> | undefined;
  let complete: ((snapshot: DesktopResourceTelemetrySnapshot | null) => void) | undefined;
  // Set before the reader drops a pipe that broke the protocol, so that close
  // is not taken for the app's exit.
  let closedByBackend = false;
  const current = () => {
    if (!latest || Date.now() - powerReceivedAt >= DESKTOP_TELEMETRY_STALE_MS) return null;
    return Date.now() - processReceivedAt < 10_000
      ? latest
      : { ...latest, processes: [], processSample: false };
  };
  connection.setEncoding("utf8");
  connection.on(
    "data",
    createTelemetryLineReader(
      (value) => {
        const appUpdate = parseDesktopAppUpdateStateFrame(value);
        if (appUpdate) {
          receiveDesktopAppUpdateSnapshot(appUpdate.state);
          return;
        }
        const snapshot = parseDesktopResourceTelemetry(value);
        if (!snapshot) return;
        powerReceivedAt = Date.now();
        nativeResourceMonitor.setHostPowerState(snapshot.power);
        if (staleTimer) clearTimeout(staleTimer);
        staleTimer = setTimeout(
          () => nativeResourceMonitor.setHostPowerState(null),
          DESKTOP_TELEMETRY_STALE_MS,
        );
        staleTimer.unref();
        if (snapshot.processSample) {
          latest = snapshot;
          processReceivedAt = Date.now();
          complete?.(snapshot);
        } else {
          // A power event must not satisfy a pending process sample or erase it.
          latest = latest ? { ...latest, power: snapshot.power } : snapshot;
        }
      },
      () => {
        closedByBackend = true;
        connection.destroy();
      },
    ),
  );
  connection.on("error", () => connection.destroy());
  connection.on("close", () => {
    detachDesktopAppUpdateChannel();
    if (staleTimer) clearTimeout(staleTimer);
    nativeResourceMonitor.setHostPowerState(null);
    latest = null;
    complete?.(null);
  });
  return {
    closedByBackend: () => closedByBackend,
    read(): Promise<DesktopResourceTelemetrySnapshot | null> {
      if (connection.destroyed) return Promise.resolve(null);
      if (pending) return pending;
      const request = new Promise<DesktopResourceTelemetrySnapshot | null>((resolve) => {
        const timer = setTimeout(() => finish(current()), 1_000);
        timer.unref();
        const finish = (snapshot: DesktopResourceTelemetrySnapshot | null) => {
          clearTimeout(timer);
          complete = undefined;
          resolve(snapshot);
        };
        complete = finish;
        connection.write('{"type":"sample"}\n', (error) => {
          if (error) finish(null);
        });
      }).finally(() => {
        pending = undefined;
      });
      pending = request;
      return request;
    },
  };
}
let receiver: ReturnType<typeof makeDesktopResourceTelemetry> | undefined;
export function initializeDesktopResourceTelemetry(fd: number): void {
  if (receiver || fd !== 4) return;
  try {
    const connection = new Socket({ fd, readable: true, writable: true });
    connection.unref();
    receiver = makeDesktopResourceTelemetry(connection);
    attachDesktopLifecycleChannel(connection);
    attachDesktopAppUpdateChannel(connection);
    watchDesktopParentPipe(connection, { closedByBackend: receiver.closedByBackend });
  } catch {
    // Optional diagnostics must never prevent backend startup.
  }
}
export function readDesktopResourceTelemetry(): Promise<DesktopResourceTelemetrySnapshot | null> {
  return receiver?.read() ?? Promise.resolve(null);
}
