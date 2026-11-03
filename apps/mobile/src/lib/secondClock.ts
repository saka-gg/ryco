import { createSharedClock } from "@ryco/shared/sharedClock";

/** The phone's once-a-second clock for elapsed times; web's labels share the same clock. */
export const secondClock = createSharedClock({ intervalMs: 1000 });
