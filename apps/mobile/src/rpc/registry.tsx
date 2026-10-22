import { RegistryContext } from "@effect/atom-react";
import { appAtomRegistry } from "@ryco/client-runtime/rpc";
import type { ReactNode } from "react";

// The single app-level @effect/atom-react registry backs both the server-state
// atoms and the RPC-backed atoms so they share reactivity and cached results,
// mirroring apps/web/src/rpc/atomRegistry.tsx.
export { appAtomRegistry, resetAppAtomRegistryForTests } from "@ryco/client-runtime/rpc";

export function AppAtomRegistryProvider({ children }: { readonly children: ReactNode }) {
  return <RegistryContext.Provider value={appAtomRegistry}>{children}</RegistryContext.Provider>;
}
