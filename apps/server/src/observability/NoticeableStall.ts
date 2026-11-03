/**
 * The last event-loop stall long enough for clients to have lost the node over it: five seconds
 * or more, kept for five minutes. The lifetime monitor (`EventLoopMonitor.ts`) notes each one;
 * the config snapshot a reconnecting client receives carries it, so the client can say why the
 * node dropped ("froze for 7 s at 14:02, load 22 on 8 cores"). Time asleep never counts.
 *
 * Boot-loaded and import-free on purpose: the monitor that writes here runs from boot, and the
 * config that reads it is built for every client.
 *
 * @module NoticeableStall
 */

/** Long enough that a client's ping gave up on the node. */
export const NOTICEABLE_STALL_MS = 5_000;
/** How long the config keeps reporting it. */
export const NOTICEABLE_STALL_MAX_AGE_MS = 5 * 60_000;

export interface NoticeableStall {
  readonly startedAtMs: number;
  readonly durationMs: number;
  readonly loadAverage1m: number | undefined;
  readonly cpuCount: number | undefined;
}

// The longest stall still within its five minutes, and the latest one: a shorter stall seen
// later does not hide a long one, and is reported once the long one ages out.
let longest: NoticeableStall | null = null;
let latest: NoticeableStall | null = null;

const reportedAt = (stall: NoticeableStall | null, nowMs: number): stall is NoticeableStall =>
  stall !== null && nowMs - stall.startedAtMs <= NOTICEABLE_STALL_MAX_AGE_MS;

/** The monitor saw a stall; only one of five seconds or more is kept. */
export function noteEventLoopStall(stall: NoticeableStall): void {
  if (!(stall.durationMs >= NOTICEABLE_STALL_MS) || !Number.isFinite(stall.startedAtMs)) return;
  if (latest === null || stall.startedAtMs >= latest.startedAtMs) latest = stall;
  if (!reportedAt(longest, stall.startedAtMs) || stall.durationMs >= longest.durationMs) {
    longest = stall;
  }
}

/** The stall to report now, as the config carries it, or undefined. */
export function readNoticeableStall(nowMs: number):
  | {
      readonly startedAt: string;
      readonly durationMs: number;
      readonly loadAverage1m?: number;
      readonly cpuCount?: number;
    }
  | undefined {
  const stall = reportedAt(longest, nowMs) ? longest : reportedAt(latest, nowMs) ? latest : null;
  if (stall === null) return undefined;
  return {
    startedAt: new Date(stall.startedAtMs).toISOString(),
    durationMs: Math.round(stall.durationMs),
    ...(stall.loadAverage1m !== undefined && Number.isFinite(stall.loadAverage1m)
      ? { loadAverage1m: Math.round(stall.loadAverage1m * 10) / 10 }
      : {}),
    ...(stall.cpuCount !== undefined && stall.cpuCount > 0 ? { cpuCount: stall.cpuCount } : {}),
  };
}

export function resetNoticeableStallForTests(): void {
  longest = null;
  latest = null;
}
