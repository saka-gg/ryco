import type { EnvironmentConnection } from "@ryco/client-runtime/connection";

import type { HostedPrimaryConnectionDeps } from "./primaryConnection";

/**
 * The seam between the always-loaded connection driver and the hosted relay
 * connection.
 *
 * The relay connection carries the relay engine, its CBOR codec, and the E2EE
 * initiator with its curve and hash primitives. Metro evaluates every static
 * import before the first frame, so the driver must not import it: a direct-only
 * launch never opens a relay. The lazily imported hosted runtime installs the
 * factory when it loads, which is before it can configure the Hub API, restore
 * a session, or select a node. Until then no primary descriptor can name a
 * selected node, and `null` is exactly what the factory itself would answer.
 */
type HostedPrimaryConnectionFactory = (
  deps: HostedPrimaryConnectionDeps,
) => EnvironmentConnection | null;

let factory: HostedPrimaryConnectionFactory | null = null;

export function installHostedPrimaryConnectionFactory(
  next: HostedPrimaryConnectionFactory | null,
): void {
  factory = next;
}

/** The hosted node's relay connection, or `null` while the hosted runtime is not loaded. */
export function createHostedPrimaryConnectionIfLoaded(
  deps: HostedPrimaryConnectionDeps,
): EnvironmentConnection | null {
  return factory === null ? null : factory(deps);
}
