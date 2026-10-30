import type { KVService } from "@ryco/client-runtime/platform";
import { requireOptionalNativeModule } from "expo";

import { createInstallCustody } from "../../platform/installCustody";
import { mobileKV } from "../../platform/kv";
import type { RycoPushNativeModule } from "./pushKeyStore";

/**
 * The push key belongs to the installation that created it
 * (`docs/push-alerts.md`), but the keychain keeps it across a delete and
 * reinstall. Its install marker works like the E2EE keys' (`installCustody.ts`):
 * without it, the key an earlier installation left is deleted before anything
 * reads or uses it, so a new installation never adopts one.
 *
 * Light on purpose: the app runs this at every launch, also when background
 * alerts were never turned on in this installation (its preferences start
 * empty after a reinstall), so it loads no push code.
 */
export const PUSH_INSTALL_MARKER_KEY = "ryco.push.install.v1";
const PUSH_INSTALL_MARKER_VALUE = "1";

/**
 * The public half of the key an earlier installation left, and when it was
 * found (`pushMemos.ts` reads it). Its node registrations sit under that
 * installation's enrollment, so this one retires them by the public key
 * (`push.unregisterDevice`), which only that installation and its nodes ever
 * held. The key itself is never adopted: it is deleted all the same.
 */
export const EARLIER_INSTALL_PUSH_KEY = "ryco.push.earlierInstallKey.v1";

export interface EarlierInstallPushKeyRecord {
  readonly publicKey: string;
  readonly recordedAt: number;
}

export function createPushKeyCustody(
  native: Pick<RycoPushNativeModule, "deleteKey" | "readKey">,
  kv: Pick<KVService, "getItem" | "setItem">,
  now: () => number = Date.now,
): () => Promise<void> {
  return createInstallCustody({
    kv,
    markerKey: PUSH_INSTALL_MARKER_KEY,
    markerValue: PUSH_INSTALL_MARKER_VALUE,
    destroy: async () => {
      // Only its public half is kept, to retire it; unreadable, it is deleted all the same.
      const left = await Promise.resolve()
        .then(() => native.readKey())
        .catch(() => null);
      await native.deleteKey();
      if (left && typeof left.publicKey === "string") {
        const record: EarlierInstallPushKeyRecord = {
          publicKey: left.publicKey,
          recordedAt: now(),
        };
        await kv.setItem(EARLIER_INSTALL_PUSH_KEY, JSON.stringify(record));
      }
    },
  });
}

let mobileModule: RycoPushNativeModule | null | undefined;
let mobileCustody: (() => Promise<void>) | undefined;

/** This build's `RycoPush` module when it can hold a push key; null on Android or without the extension. */
export function readMobileRycoPush(): RycoPushNativeModule | null {
  if (mobileModule === undefined) {
    const native = requireOptionalNativeModule<RycoPushNativeModule>("RycoPush");
    mobileModule = native !== null && native.isAvailable() ? native : null;
  }
  return mobileModule;
}

/**
 * The app's one custody check, shared by the launch and the push key store so
 * a key the store just created is never taken for an earlier installation's.
 */
export function ensureMobilePushKeyCustody(): Promise<void> {
  const native = readMobileRycoPush();
  if (native === null) return Promise.resolve();
  mobileCustody ??= createPushKeyCustody(native, mobileKV);
  return mobileCustody();
}

/**
 * What every launch does for push, before alerts were ever turned on: the
 * install check, then whether an earlier installation's key still waits to be
 * retired on its machines (background alerts then start just for that).
 */
export async function checkPushKeyAtLaunch(input: {
  readonly custody: () => Promise<void>;
  readonly kv: Pick<KVService, "getItem">;
}): Promise<{ readonly retireEarlierKey: boolean }> {
  await input.custody();
  return { retireEarlierKey: (await input.kv.getItem(EARLIER_INSTALL_PUSH_KEY)) !== null };
}

/** {@link checkPushKeyAtLaunch} with this build's key and the app's storage. */
export function checkMobilePushKeyAtLaunch(): Promise<{ readonly retireEarlierKey: boolean }> {
  return checkPushKeyAtLaunch({ custody: ensureMobilePushKeyCustody, kv: mobileKV });
}
