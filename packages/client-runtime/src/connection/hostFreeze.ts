import type { ServerEventLoopStall } from "@ryco/contracts";

/**
 * hostFreeze - Why a machine just dropped, when it froze: the node keeps its
 * last event-loop stall of five seconds or more for five minutes, and every
 * client says it the same way ("Froze for 7 s at 14:02, load 22 on 8 cores").
 * Read from the config the node sent on reconnecting; never cached.
 *
 * @module connection/hostFreeze
 */

function twoDigits(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** Local wall-clock time ("14:02"), without Intl: full ICU is not guaranteed on Hermes. */
export function localClockTime(ms: number): string {
  const date = new Date(ms);
  return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

function loadLabel(load: number): string {
  return load >= 10 ? String(Math.round(load)) : String(Math.round(load * 10) / 10);
}

/**
 * How long a client shows the notice: as long as the node reports it. The node
 * stops reporting after five minutes, but a client keeps the config it last
 * received, so each client drops the notice on its own clock.
 */
export const HOST_FREEZE_NOTICE_MS = 5 * 60_000;

function startedAtOf(stall: ServerEventLoopStall | null | undefined): number | null {
  if (!stall) return null;
  const startedAtMs = Date.parse(stall.startedAt);
  return Number.isFinite(startedAtMs) && stall.durationMs > 0 ? startedAtMs : null;
}

/**
 * The one-line notice for a node's last noticeable stall, or null when it
 * reported none (or an unreadable one) or its five minutes are over at `nowMs`.
 * The load reads against the cores only when both are known.
 */
export function describeHostFreeze(
  stall: ServerEventLoopStall | null | undefined,
  options: { readonly nowMs: number; readonly formatTime?: (ms: number) => string },
): string | null {
  const startedAtMs = startedAtOf(stall);
  if (!stall || startedAtMs === null || options.nowMs - startedAtMs > HOST_FREEZE_NOTICE_MS) {
    return null;
  }
  const seconds = Math.max(1, Math.round(stall.durationMs / 1_000));
  const at = (options.formatTime ?? localClockTime)(startedAtMs);
  const load =
    stall.loadAverage1m === undefined
      ? ""
      : stall.cpuCount === undefined
        ? `, load ${loadLabel(stall.loadAverage1m)}`
        : `, load ${loadLabel(stall.loadAverage1m)} on ${stall.cpuCount} ${stall.cpuCount === 1 ? "core" : "cores"}`;
  return `Froze for ${seconds} s at ${at}${load}`;
}

/**
 * When the first notice still showing at `nowMs` goes away, or null when none
 * shows: a client that has no ticking clock re-renders then.
 */
export function nextHostFreezeExpiryMs(
  stalls: Iterable<ServerEventLoopStall | null | undefined>,
  nowMs: number,
): number | null {
  let next: number | null = null;
  for (const stall of stalls) {
    const startedAtMs = startedAtOf(stall);
    if (startedAtMs === null) continue;
    const expiresAtMs = startedAtMs + HOST_FREEZE_NOTICE_MS;
    if (expiresAtMs >= nowMs && (next === null || expiresAtMs < next)) next = expiresAtMs;
  }
  return next;
}
