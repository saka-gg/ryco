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

/**
 * Phase durations are forwarded only for phases that began while the backend was starting: phases
 * with the same names also run later (settings hot reload re-creates provider instances), and
 * those must not flood the desktop log. Startup ends once both end milestones are recorded:
 * `complete` (the startup sequence finished) and `providers-ready` (the initial provider instance
 * build settled). Provider drivers are built only after the listener serves, so their initial
 * build starts after `complete`; closing at `complete` alone would drop every initial
 * `provider.instance.create:*` phase. The window caps startup when a milestone never arrives. A
 * phase that began during startup is forwarded however late it ends, because the long ones (a
 * migration backfill on a large database) are the reason these frames exist. The frame cap bounds
 * a pathological startup with many provider instances.
 */
export const DESKTOP_STARTUP_PHASE_FORWARD_WINDOW_MS = 60_000;
export const DESKTOP_STARTUP_PHASE_FORWARD_MAX_FRAMES = 128;
export const DESKTOP_STARTUP_COMPLETE_PHASE = "complete";
export const DESKTOP_STARTUP_PROVIDERS_READY_PHASE = "providers-ready";
let forwardedStartupPhaseFrames = 0;
let startupCompletedAtMs: number | null = null;
let providersReadyAtMs: number | null = null;

/** When startup ended (both end milestones recorded), or `null` while it is still running. */
const resolveStartupEndMs = (): number | null =>
  startupCompletedAtMs === null || providersReadyAtMs === null
    ? null
    : Math.max(startupCompletedAtMs, providersReadyAtMs);

export function attachDesktopLifecycleChannel(writable: Writable): void {
  channel = writable;
}

export function detachDesktopLifecycleChannelForTests(): void {
  channel = null;
  forwardedStartupPhaseFrames = 0;
  startupCompletedAtMs = null;
  providersReadyAtMs = null;
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

/** Reports a coarse startup milestone as milliseconds since process start. */
export function recordDesktopStartupPhase(name: string): void {
  const nowMs = performance.now();
  if (name === DESKTOP_STARTUP_COMPLETE_PHASE && startupCompletedAtMs === null) {
    startupCompletedAtMs = nowMs;
  }
  if (name === DESKTOP_STARTUP_PROVIDERS_READY_PHASE && providersReadyAtMs === null) {
    providersReadyAtMs = nowMs;
  }
  writeDesktopLifecycleFrame({
    type: "startup-phase",
    name,
    ms: Math.round(nowMs),
  });
}

/**
 * Reports how long a startup phase ran. Both times are `performance.now()` readings (milliseconds
 * since process start). Ignored for phases that began after startup (see
 * {@link DESKTOP_STARTUP_PHASE_FORWARD_WINDOW_MS}) or once the frame cap is reached.
 */
export function recordDesktopStartupPhaseDuration(
  name: string,
  startedAtMs: number,
  endedAtMs: number,
): void {
  if (channel === null) return;
  if (startedAtMs > DESKTOP_STARTUP_PHASE_FORWARD_WINDOW_MS) return;
  const startupEndMs = resolveStartupEndMs();
  if (startupEndMs !== null && startedAtMs > startupEndMs) return;
  if (forwardedStartupPhaseFrames >= DESKTOP_STARTUP_PHASE_FORWARD_MAX_FRAMES) return;
  forwardedStartupPhaseFrames += 1;
  writeDesktopLifecycleFrame({
    type: "startup-phase",
    name,
    ms: Math.round(endedAtMs),
    durationMs: Math.max(0, Math.round(endedAtMs - startedAtMs)),
  });
}
