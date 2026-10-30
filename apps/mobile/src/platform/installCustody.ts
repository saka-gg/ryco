import type { KVService } from "@ryco/client-runtime/platform";

/**
 * Keychain material that must die with the installation that created it.
 *
 * Keychain items survive deleting the app and installing it again for the same
 * bundle id; the SQLite-backed KV does not, because it lives in the
 * application container. A marker in the KV therefore tells material this
 * installation created from material an earlier one left, and the earlier
 * one's is destroyed, never adopted (`docs/relay-e2ee-protocol.md` §6.3 for the
 * E2EE keys, `docs/push-alerts.md` for the push key).
 *
 * The returned check runs before the material is touched at all, once per
 * process. Ordering is the whole point of it: destroy first, mark second.
 * Marking first and then failing to destroy would declare a resurrected key
 * adopted; destroying first and then failing to mark costs a redundant destroy
 * on the next launch and nothing else. Nothing is read to decide: a missing
 * marker destroys unconditionally, so no value from the earlier installation is
 * ever loaded.
 *
 * The marker value is a version rather than a flag, so a later build can force
 * one more destroy.
 */
export function createInstallCustody(options: {
  readonly kv: Pick<KVService, "getItem" | "setItem">;
  readonly markerKey: string;
  readonly markerValue: string;
  readonly destroy: () => Promise<void>;
}): () => Promise<void> {
  let custody: Promise<void> | undefined;
  return async () => {
    custody ??= (async () => {
      const marker = await options.kv.getItem(options.markerKey);
      if (marker === options.markerValue) return;
      await options.destroy();
      await options.kv.setItem(options.markerKey, options.markerValue);
    })().catch((cause: unknown) => {
      // Not memoized on failure: an unreadable marker is a condition to retry,
      // and every retry runs the whole destroy-then-mark sequence again.
      custody = undefined;
      throw cause;
    });
    return await custody;
  };
}
