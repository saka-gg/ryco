/**
 * desktopAppUpdateBridge - The backend's end of the desktop app's update channel.
 *
 * A desktop-launched backend shares an inherited pipe (fd 4) with its Electron app.
 * The app reports its updater state on it (`app-update-state`), and the backend relays
 * a client's check or install request (`app-update-check`, `app-update-install`). The
 * app owns the updater; this module only mirrors its last report and forwards
 * requests. Outside desktop mode no pipe is attached: `current()` stays `null` and
 * `request` answers `false`.
 *
 * @module desktopAppUpdateBridge
 */
import type { Writable } from "node:stream";

import type {
  DesktopAppUpdateRequestFrame,
  DesktopAppUpdateSnapshot,
} from "@ryco/shared/desktopResourceTelemetry";

export interface DesktopAppUpdateBridge {
  /** The app's last reported updater state; `null` until it reports one. */
  readonly current: () => DesktopAppUpdateSnapshot | null;
  /** Called with every new report; returns the unsubscribe function. */
  readonly subscribe: (listener: (snapshot: DesktopAppUpdateSnapshot) => void) => () => void;
  /** Forwards a request to the app; `false` when no app is attached to hear it. */
  readonly request: (frame: DesktopAppUpdateRequestFrame) => boolean;
}

let channel: Writable | null = null;
let latest: DesktopAppUpdateSnapshot | null = null;
const listeners = new Set<(snapshot: DesktopAppUpdateSnapshot) => void>();

export function attachDesktopAppUpdateChannel(writable: Writable): void {
  channel = writable;
}

/** Called by the pipe reader for each valid `app-update-state` frame. */
export function receiveDesktopAppUpdateSnapshot(snapshot: DesktopAppUpdateSnapshot): void {
  latest = snapshot;
  for (const listener of Array.from(listeners)) {
    try {
      listener(snapshot);
    } catch {
      // A failing listener must not stop the others or the pipe reader.
    }
  }
}

/** The pipe closed: the app is gone, so its last report no longer describes anything. */
export function detachDesktopAppUpdateChannel(): void {
  channel = null;
  latest = null;
}

export function resetDesktopAppUpdateBridgeForTests(): void {
  channel = null;
  latest = null;
  listeners.clear();
}

export const desktopAppUpdateBridge: DesktopAppUpdateBridge = {
  current: () => latest,
  subscribe: (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  request: (frame) => {
    const target = channel;
    if (target === null || target.destroyed || !target.writable) return false;
    try {
      target.write(`${JSON.stringify(frame)}\n`);
      return true;
    } catch {
      return false;
    }
  },
};
