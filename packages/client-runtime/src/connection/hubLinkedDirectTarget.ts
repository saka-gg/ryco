import type {
  AuthLinkedDirectAccess,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
} from "@ryco/contracts";

import type { DirectRouteIdentityOutcome } from "./directRouteIdentity.ts";
import { directAddressAuthenticatesMachine } from "./environmentRoutes.ts";

/**
 * Where a Hub-linked grant's code may be redeemed (`hubLinkedDirectAccess.ts`).
 * A module of its own: only linking uses it, so it loads with the link code
 * and never with the app's first paint.
 */

/** What adding direct access to a Hub machine came to, on Desktop or the phone. */
export type HubLinkOutcome =
  | "linked"
  /** The owner paired this machine by hand; that pairing is left alone. */
  | "already-paired"
  /** The machine listens on loopback only. */
  | "no-direct-endpoint"
  /** The machine is older than the direct identity proof: it names no key to prove. */
  | "node-update-required"
  /** None of its HTTPS or Tailscale addresses answered as the machine from this network. */
  | "unreachable";

/** What "Add direct access" reports. `null` once linked: the row then says so itself. */
export function describeHubLinkOutcome(
  label: string,
  outcome: HubLinkOutcome | "failed",
): string | null {
  switch (outcome) {
    case "linked":
      return null;
    case "already-paired":
      return `${label} is already paired directly on this device.`;
    case "no-direct-endpoint":
      return `${label} only listens on its own loopback address, so no other device can reach it directly.`;
    case "node-update-required":
      return `Update Ryco on ${label} first: this version can't prove which machine answers at its direct address.`;
    case "unreachable":
      return `None of ${label}'s Tailscale or HTTPS addresses answered as ${label} from this network.`;
    case "failed":
      return `Direct access to ${label} could not be set up. Try again in a moment.`;
  }
}

/** Each endpoint probe; a slow LAN address must not hold up the relay connection. */
export const HUB_LINKED_DIRECT_ACCESS_PROBE_TIMEOUT_MS = 3_000;

export interface HubLinkedDirectTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly credential: string;
  /** The key the address proved; every later use of the link proves it again. */
  readonly nodeIdentityPublicKey: string;
}

/** Settles `null` after `timeoutMs`, aborting `controller`. */
function withTimeout<A>(
  run: (signal: AbortSignal) => Promise<A>,
  timeoutMs: number,
): Promise<A | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  return Promise.race([run(controller.signal), timedOut]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * The first endpoint, in the node's preference order, whose transport names
 * the machine (HTTPS or a Tailscale address), that answers with the node's own
 * direct environment id, and then proves it holds the node identity key the
 * grant named: the same node, not merely something listening there or a copy
 * of its public descriptor. `null` when none does, and always for a grant from
 * a node older than the proof (it names no key), so its code is never sent
 * anywhere. Plain LAN and public addresses are never probed: no route uses them.
 */
export async function resolveHubLinkedDirectTarget(input: {
  readonly access: Extract<AuthLinkedDirectAccess, { readonly kind: "issued" }>;
  readonly fetchDescriptor: (httpBaseUrl: string) => Promise<ExecutionEnvironmentDescriptor>;
  readonly proveIdentity: (input: {
    readonly httpBaseUrl: string;
    readonly environmentId: EnvironmentId;
    readonly nodeIdentityPublicKey: string;
    readonly signal: AbortSignal;
  }) => Promise<DirectRouteIdentityOutcome>;
  readonly timeoutMs?: number;
}): Promise<HubLinkedDirectTarget | null> {
  const nodeIdentityPublicKey = input.access.nodeIdentityPublicKey;
  if (nodeIdentityPublicKey === undefined) return null;
  const timeoutMs = input.timeoutMs ?? HUB_LINKED_DIRECT_ACCESS_PROBE_TIMEOUT_MS;
  for (const endpoint of input.access.endpoints) {
    if (!directAddressAuthenticatesMachine(endpoint.httpBaseUrl)) continue;
    try {
      const descriptor = await withTimeout(
        () => input.fetchDescriptor(endpoint.httpBaseUrl),
        timeoutMs,
      );
      if (descriptor?.environmentId !== input.access.environmentId) continue;
      const proof = await withTimeout(
        (signal) =>
          input.proveIdentity({
            httpBaseUrl: endpoint.httpBaseUrl,
            environmentId: input.access.environmentId,
            nodeIdentityPublicKey,
            signal,
          }),
        timeoutMs,
      );
      if (proof !== "proven") continue;
      return {
        environmentId: input.access.environmentId,
        label: input.access.label,
        httpBaseUrl: endpoint.httpBaseUrl,
        wsBaseUrl: endpoint.wsBaseUrl,
        credential: input.access.credential,
        nodeIdentityPublicKey,
      };
    } catch {
      // Unreachable from here: try the next one.
    }
  }
  return null;
}
