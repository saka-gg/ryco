import { retainHostedDirectoryPresenceDemand } from "@ryco/client-runtime/authorization";
import { useEffect } from "react";

/**
 * Hold directory presence demand while `active`: for a surface that shows Hub
 * node presence, called with whether it is the focused screen.
 *
 * Without an account subscription this app polls the node directory at the
 * normal cadence only while some surface holds demand, and at the two-minute
 * backstop otherwise, since every read costs a device-key signature and a
 * radio wakeup. Focusing such a surface reads at once when the last read is
 * already older than the normal cadence.
 */
export function useDirectoryPresenceDemand(active: boolean): void {
  useEffect(() => (active ? retainHostedDirectoryPresenceDemand() : undefined), [active]);
}
