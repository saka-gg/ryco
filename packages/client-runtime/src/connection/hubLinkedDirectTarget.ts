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
