import type { ServerEventLoopStall } from "@ryco/contracts";
import { nextHostFreezeExpiryMs } from "@ryco/client-runtime/connection";
import { useEffect, useState } from "react";

/**
 * The time to read machines' freeze notices at (`describeHostFreeze`). It
 * moves only when a notice showing at it goes away, so a screen without a
 * ticking clock drops the notice five minutes after the freeze.
 */
export function useHostFreezeNowMs(
  stalls: Iterable<ServerEventLoopStall | null | undefined>,
): number {
  const [nowMs, setNowMs] = useState(Date.now);
  const expiresAtMs = nextHostFreezeExpiryMs(stalls, nowMs);
  useEffect(() => {
    if (expiresAtMs === null) return;
    const timer = setTimeout(() => setNowMs(Date.now()), Math.max(0, expiresAtMs - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [expiresAtMs]);
  return nowMs;
}
