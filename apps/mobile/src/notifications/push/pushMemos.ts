import type { PushKey } from "@ryco/client-runtime/notifications/push";
import type { KVService } from "@ryco/client-runtime/platform";

import { EARLIER_INSTALL_PUSH_KEY, type EarlierInstallPushKeyRecord } from "./pushKeyCustody";
import { pushKeyOf } from "./pushKeyStore";

/**
 * What background alerts keep in the app's storage across restarts
 * (`docs/push-alerts.md`). The storage lives in the app's container, so a
 * reinstall starts without either; the keychain is what survives it, which is
 * why the install check records an earlier installation's key here.
 */

/** The account whose Hub registration was turned off but not removed yet. */
export const HUB_REMOVAL_OWED_KEY = "ryco.push.hubRemovalOwed.v1";

/** The push registration each node last confirmed (`BackgroundAlertsPorts.nodeRegistrations`). */
export const NODE_REGISTRATIONS_KEY = "ryco.push.nodeRegistrations.v1";

/**
 * What nodes confirmed, so a connect after a restart asks with its presence instead of
 * registering again. Holds machine ids, the enrollment id and the key id: nothing secret.
 */
export function createNodeRegistrationsMemo(
  kv: Pick<KVService, "getItem" | "setItem" | "removeItem">,
) {
  return {
    read: () => kv.getItem(NODE_REGISTRATIONS_KEY),
    write: (value: string | null): Promise<void> =>
      value === null
        ? kv.removeItem(NODE_REGISTRATIONS_KEY)
        : kv.setItem(NODE_REGISTRATIONS_KEY, value),
  };
}

/**
 * A node drops a registration nobody refreshed for 30 days, so an earlier
 * installation's key needs retiring no longer than that.
 */
export const EARLIER_INSTALL_KEY_RETIRE_MS = 30 * 24 * 60 * 60 * 1_000;

/** The owed Hub removal, until the Hub confirms it (`BackgroundAlertsPorts.hubRemoval`). */
export function createHubRemovalMarker(kv: Pick<KVService, "getItem" | "setItem" | "removeItem">) {
  return {
    read: () => kv.getItem(HUB_REMOVAL_OWED_KEY),
    write: (accountId: string | null): Promise<void> =>
      accountId === null
        ? kv.removeItem(HUB_REMOVAL_OWED_KEY)
        : kv.setItem(HUB_REMOVAL_OWED_KEY, accountId),
  };
}

function readRecord(raw: string): EarlierInstallPushKeyRecord | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { publicKey, recordedAt } = value as Record<string, unknown>;
    return typeof publicKey === "string" && typeof recordedAt === "number"
      ? { publicKey, recordedAt }
      : null;
  } catch {
    return null;
  }
}

/**
 * The key an earlier installation left (`BackgroundAlertsPorts.earlierInstallKey`):
 * the install check recorded its public half. One that is unreadable, or older
 * than a node keeps an unrefreshed registration, is dropped as it is read.
 */
export function createEarlierInstallKeyMemo(
  kv: Pick<KVService, "getItem" | "removeItem">,
  now: () => number = Date.now,
) {
  const clear = () => kv.removeItem(EARLIER_INSTALL_PUSH_KEY);
  return {
    read: async (): Promise<PushKey | null> => {
      const raw = await kv.getItem(EARLIER_INSTALL_PUSH_KEY);
      if (raw === null) return null;
      const record = readRecord(raw);
      let key: PushKey | null = null;
      if (record !== null && now() - record.recordedAt < EARLIER_INSTALL_KEY_RETIRE_MS) {
        try {
          key = pushKeyOf({ publicKey: record.publicKey, enrollmentId: null });
        } catch {
          key = null;
        }
      }
      if (key === null) await clear();
      return key;
    },
  };
}
