import { createContext, useContext, useMemo, type ReactNode } from "react";

import { initializeMobileRuntime, type MobileConnectionRegistry } from "../runtime/bootstrap";

// App-wide access to the single-homed connection registry ({catalog, driver,
// remoteApi}). B1 only prop-passed it to PairingScreen; B2 screens (Home, thread
// detail, connections, settings) reach `catalog`/`driver` through this context.
// The registry itself stays the bootstrap singleton — the provider does not mint
// a second one; it exposes the one `initializeMobileRuntime()` returns.
const ConnectionRegistryContext = createContext<MobileConnectionRegistry | null>(null);

export function ConnectionRegistryProvider(props: {
  readonly children: ReactNode;
  // Tests inject an isolated registry; the app omits this and gets the singleton.
  readonly registry?: MobileConnectionRegistry;
}) {
  const registry = useMemo(() => props.registry ?? initializeMobileRuntime(), [props.registry]);
  return (
    <ConnectionRegistryContext.Provider value={registry}>
      {props.children}
    </ConnectionRegistryContext.Provider>
  );
}

export function useConnectionRegistry(): MobileConnectionRegistry {
  const registry = useContext(ConnectionRegistryContext);
  if (!registry) {
    throw new Error("useConnectionRegistry must be used within a ConnectionRegistryProvider");
  }
  return registry;
}
