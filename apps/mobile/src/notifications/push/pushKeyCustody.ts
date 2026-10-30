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

export function createPushKeyCustody(
  native: Pick<RycoPushNativeModule, "deleteKey">,
  kv: Pick<KVService, "getItem" | "setItem">,
): () => Promise<void> {
  return createInstallCustody({
    kv,
    markerKey: PUSH_INSTALL_MARKER_KEY,
    markerValue: PUSH_INSTALL_MARKER_VALUE,
    destroy: () => native.deleteKey(),
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
