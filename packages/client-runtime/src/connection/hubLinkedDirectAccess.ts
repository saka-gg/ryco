import type {
  AuthLinkedDirectAccess,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
} from "@ryco/contracts";

import type { SavedEnvironmentRecord } from "./catalog.ts";

/**
 * Hub-linked direct access, the client half
 * (`docs/superpowers/specs/2026-10-14-hub-linked-direct-access-design.md`).
 *
 * A native client connected to a node over a trusted Hub relay channel asks it
 * for a one-time code, finds which of the node's direct endpoints answers as
 * that same node, and redeems the code there like a pasted pairing link. The
 * node's linked session lives seven days; the client links again through the
 * relay well before then.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Link again once the stored direct credential is this old: within its seven days. */
export const HUB_LINKED_DIRECT_ACCESS_RENEW_AFTER_MS = 3 * DAY_MS;
/** Each endpoint probe; a slow LAN address must not hold up the relay connection. */
export const HUB_LINKED_DIRECT_ACCESS_PROBE_TIMEOUT_MS = 3_000;

/**
 * Whether to ask a node for direct access now. A saved environment the user
 * paired by hand is theirs and never replaced; one linked through another Hub
 * machine id, or linked long enough ago, is due.
 */
export function hubLinkedDirectAccessDue(input: {
  readonly hubEnvironmentId: string;
  readonly records: ReadonlyArray<SavedEnvironmentRecord>;
  readonly nowMs: number;
}): boolean {
  const linked = input.records.find(
    (record) => record.hubLink?.hubEnvironmentId === input.hubEnvironmentId,
  );
  if (linked?.hubLink === undefined) return true;
  const linkedAtMs = Date.parse(linked.hubLink.linkedAt);
  return (
    !Number.isFinite(linkedAtMs) ||
    input.nowMs - linkedAtMs >= HUB_LINKED_DIRECT_ACCESS_RENEW_AFTER_MS
  );
}

/** A saved environment for this direct id that was paired by hand, not linked. */
export function isManuallyPairedEnvironment(
  records: ReadonlyArray<SavedEnvironmentRecord>,
  environmentId: EnvironmentId,
): boolean {
  return records.some(
    (record) => record.environmentId === environmentId && record.hubLink === undefined,
  );
}

export interface HubLinkedDirectTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly credential: string;
}

/**
 * The first endpoint, in the node's preference order, that answers with the
 * node's own direct environment id: a reachable address that is the same node,
 * not merely something listening there. `null` when none does.
 */
export async function resolveHubLinkedDirectTarget(input: {
  readonly access: Extract<AuthLinkedDirectAccess, { readonly kind: "issued" }>;
  readonly fetchDescriptor: (httpBaseUrl: string) => Promise<ExecutionEnvironmentDescriptor>;
  readonly timeoutMs?: number;
}): Promise<HubLinkedDirectTarget | null> {
  const timeoutMs = input.timeoutMs ?? HUB_LINKED_DIRECT_ACCESS_PROBE_TIMEOUT_MS;
  for (const endpoint of input.access.endpoints) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    try {
      const descriptor = await Promise.race([
        input.fetchDescriptor(endpoint.httpBaseUrl),
        timedOut,
      ]);
      if (descriptor?.environmentId === input.access.environmentId) {
        return {
          environmentId: input.access.environmentId,
          label: input.access.label,
          httpBaseUrl: endpoint.httpBaseUrl,
          wsBaseUrl: endpoint.wsBaseUrl,
          credential: input.access.credential,
        };
      }
    } catch {
      // Unreachable from here: try the next one.
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return null;
}
