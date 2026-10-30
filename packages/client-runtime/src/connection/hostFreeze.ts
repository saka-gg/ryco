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

/** Local wall-clock time, without Intl: full ICU is not guaranteed on Hermes. */
function clock(ms: number): string {
  const date = new Date(ms);
  return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

function loadLabel(load: number): string {
  return load >= 10 ? String(Math.round(load)) : String(Math.round(load * 10) / 10);
}

/**
 * The one-line notice for a node's last noticeable stall, or null when it
 * reported none (or an unreadable one). The load reads against the cores only
 * when both are known.
 */
export function describeHostFreeze(
  stall: ServerEventLoopStall | null | undefined,
  options?: { readonly formatTime?: (ms: number) => string },
): string | null {
  if (!stall) return null;
  const startedAtMs = Date.parse(stall.startedAt);
  if (!Number.isFinite(startedAtMs) || !(stall.durationMs > 0)) return null;
  const seconds = Math.max(1, Math.round(stall.durationMs / 1_000));
  const at = (options?.formatTime ?? clock)(startedAtMs);
  const load =
    stall.loadAverage1m === undefined
      ? ""
      : stall.cpuCount === undefined
        ? `, load ${loadLabel(stall.loadAverage1m)}`
        : `, load ${loadLabel(stall.loadAverage1m)} on ${stall.cpuCount} ${stall.cpuCount === 1 ? "core" : "cores"}`;
  return `Froze for ${seconds} s at ${at}${load}`;
}
