/**
 * desktopLifecycle - Structured backend lifecycle frames for the desktop shell.
 *
 * Desktop-launched backends share an inherited duplex pipe (fd 4) with the
 * Electron main process. Besides resource telemetry, the backend writes
 * newline-delimited lifecycle frames on it (`http-bound`, `http-serving`,
 * `startup-ready`, `startup-phase`, `fatal`) so desktop readiness does not
 * depend on parsing log text. Outside desktop mode no channel is attached and
 * every write is a no-op.
 *
 * @module desktopLifecycle
 */
import type { Writable } from "node:stream";

import type { DesktopBackendLifecycleFrame } from "@ryco/shared/desktopResourceTelemetry";

let channel: Writable | null = null;

export function attachDesktopLifecycleChannel(writable: Writable): void {
  channel = writable;
}

export function detachDesktopLifecycleChannelForTests(): void {
  channel = null;
}

/** Best effort: lifecycle frames must never affect the backend itself. */
export function writeDesktopLifecycleFrame(frame: DesktopBackendLifecycleFrame): void {
  const target = channel;
  if (target === null || target.destroyed || !target.writable) return;
  try {
    target.write(`${JSON.stringify(frame)}\n`, () => {});
  } catch {
    // The desktop may already have closed its end.
  }
}

/** Reports a coarse startup phase as milliseconds since process start. */
export function recordDesktopStartupPhase(name: string): void {
  writeDesktopLifecycleFrame({
    type: "startup-phase",
    name,
    ms: Math.round(performance.now()),
  });
}
