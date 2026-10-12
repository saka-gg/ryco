import { useEffect, useState } from "react";

import {
  ensureMobileHostedDeviceKey,
  isMobileHostedModeAvailable,
  subscribeMobileHostedModeAvailability,
} from "../../hostedHub/state";

/**
 * Whether this build can run the hosted plane at all.
 *
 * `isMobileHostedModeAvailable()` is false until the runtime has been
 * configured, and configuration is async because it must resolve a hardware
 * key first — so a plain call at render time would report "unavailable" for
 * every hosted build on first paint. `ensureMobileHostedDeviceKey()` awaits the
 * single, memoized session setup (token hydration, runtime configuration,
 * bootstrap) and then loads the hardware key, which the setup defers when no
 * session is stored. It leaves hosted mode unavailable on a direct-only build
 * or on a device with no usable enclave key, which is exactly the
 * "unavailable" answer this hook needs. A mounted hosted surface is first
 * hosted use, so this is where a signed-out launch loads the key.
 *
 * Every hosted surface gates on this: with hosted mode unavailable, no hosted
 * affordance renders at all, rather than rendering a tappable-but-broken one.
 */
export function useHostedModeAvailable(): boolean {
  const [available, setAvailable] = useState(isMobileHostedModeAvailable);

  useEffect(() => {
    let active = true;
    const settle = () => {
      if (active) setAvailable(isMobileHostedModeAvailable());
    };
    const unsubscribe = subscribeMobileHostedModeAvailability(settle);
    void ensureMobileHostedDeviceKey().then(settle, settle);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return available;
}
