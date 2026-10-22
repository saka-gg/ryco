import type { EnvironmentConnection } from "@ryco/client-runtime/connection";

import type {
  HostedEnvironmentConnectionInput,
  HostedPrimaryConnectionDeps,
} from "./primaryConnection";

/**
 * The seam between the always-loaded connection code and the hosted relay
 * connection.
 *
 * The relay connection carries the relay engine, its CBOR codec, and the E2EE
 * initiator with its curve and hash primitives. Metro evaluates every static
 * import before the first frame, so the connection driver must not import it:
 * a direct-only launch never opens a relay. The lazily imported hosted runtime
 * installs the factory when it loads, which is before it can configure the Hub
 * API, restore a session, or select a node.
 */
type HostedPrimaryConnectionFactory = (
  deps: HostedPrimaryConnectionDeps,
) => EnvironmentConnection | null;

type HostedEnvironmentConnectionFactory = (
  input: HostedEnvironmentConnectionInput,
) => EnvironmentConnection;

let primaryFactory: HostedPrimaryConnectionFactory | null = null;
let environmentFactory: HostedEnvironmentConnectionFactory | null = null;

/**
 * The driver's primary connection, built for whatever node is selected. The
 * hosted runtime installs none: every hosted environment's connection is
 * created through the hosted controller's bounded connect path instead
 * ({@link createHostedEnvironmentConnectionIfLoaded}), so the driver's own
 * primary connection stays `null` and cannot open a second, unbounded one.
 */
export function installHostedPrimaryConnectionFactory(
  next: HostedPrimaryConnectionFactory | null,
): void {
  primaryFactory = next;
}

/** The driver's primary connection, or `null` when no factory is installed. */
export function createHostedPrimaryConnectionIfLoaded(
  deps: HostedPrimaryConnectionDeps,
): EnvironmentConnection | null {
  return primaryFactory === null ? null : primaryFactory(deps);
}

export function installHostedEnvironmentConnectionFactory(
  next: HostedEnvironmentConnectionFactory | null,
): void {
  environmentFactory = next;
}

/** One hosted environment's relay connection, or `null` while the hosted runtime is not loaded. */
export function createHostedEnvironmentConnectionIfLoaded(
  input: HostedEnvironmentConnectionInput,
): EnvironmentConnection | null {
  return environmentFactory === null ? null : environmentFactory(input);
}
