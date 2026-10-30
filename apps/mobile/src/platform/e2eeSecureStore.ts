import type { KVService } from "@ryco/client-runtime/platform";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import { createInstallCustody } from "./installCustody";
import { mobileKV } from "./kv";
import { sanitizeSecretKey } from "./secretKv";

/**
 * The device-only keychain namespace that holds relay-E2EE private material —
 * `docs/relay-e2ee-protocol.md` §6.3 (custody by endpoint), whose native-client
 * row requires the entry to be "device-only, non-synchronizing, excluded from
 * backup, restore, and device-transfer on both platforms", with an iOS
 * this-device-only accessibility class.
 *
 * A SECOND STORE, NOT A SETTING ON THE FIRST. `mobileSecretKV` holds the hosted
 * session token and the per-environment bearer tokens and passes NO options, so
 * those items sit in the library's default service under its default
 * accessibility. Changing that store's options would not migrate them: iOS
 * `SecItemUpdate` sends only `kSecValueData` (verified against
 * `expo-secure-store/ios/SecureStoreModule.swift`), so every already-written item
 * would silently keep its old class while new writes got the new one. The E2EE
 * material therefore gets its own `keychainService`, which is its own
 * `kSecAttrService` and its own Android keystore alias, and the bearer stores are
 * left exactly as they are.
 *
 * `requireAuthentication` IS NEVER PASSED. expo-secure-store folds that option
 * into a `.biometryCurrentSet` access control, so enrolling a new fingerprint or
 * re-registering a face destroys the key — and with it every pin the device
 * holds. That is the same reason the device-key module chose
 * `setUserAuthenticationRequired(false)`. Device unlock, not biometry re-enrolment
 * survivability, is the property this material needs.
 *
 * THE NAMESPACE IS ENUMERABLE BY CONSTRUCTION. Callers address entries through
 * `E2eeSecureStoreKey`, a closed union of the names below, because §6.3's
 * clone/restore prohibition requires destroying the whole namespace WITHOUT
 * reading any of it first — and neither platform lets JavaScript enumerate a
 * keychain service. A closed key set is what makes "destroy everything" a
 * complete operation instead of a best-effort one.
 */

/** The device's static X25519 agreement secret (§6.2: one per device). */
export const E2EE_AGREEMENT_SECRET_KEY = "ryco.e2ee.agreementKey.v1";

/**
 * The whole §13.1 trust document — pin records, the `anyNodeVerified` markers,
 * and the strict-legacy policy — as ONE entry.
 *
 * §13.1.1 places every durable trust value in this storage class, not only the
 * secret ones, and §13.1 requires the marker to be "committed atomically with the
 * promotion that sets it". Neither platform store offers a transaction across
 * two entries, so one entry is the only construction under which a crash between
 * the promotion and the marker write cannot exist to be observed.
 *
 * It joins the closed union rather than sitting beside it: §6.3's clone/restore
 * purge destroys exactly the names listed below, and a pin set that survived a
 * reinstall while the agreement key it was taken against did not is the state
 * §13.1.1 describes as indistinguishable from a fresh install. The first-run
 * marker value is deliberately NOT bumped for it — this name has never been
 * written by an earlier build, so no installation can be holding an orphan under
 * it, and a bump would destroy a working device's agreement key on upgrade.
 */
export const E2EE_TRUST_DOCUMENT_KEY = "ryco.e2ee.trustDocument.v1";

/**
 * The device's §7.4 client agreement-prekey certificate.
 *
 * IT IS NOT A SECRET, AND THAT IS NOT WHY IT IS HERE. §6.3's class governs
 * SURVIVAL, not confidentiality: this entry names the agreement key, and an entry
 * that outlived the key it names is exactly §13.1.1's partial-loss shape —
 * "non-secret application state recording a prior E2EE association" that survives
 * an OS migration while the §6.3 namespace does not, which §13.1.1 then requires
 * be treated as UNEXPECTED rather than legacy-eligible. §13.1.1 also names the
 * alternative this takes: a client that keeps no such record "is a fresh install
 * by the rule above", and the obligation does not arise. Storing it here makes it
 * die with the key, so it can never be the odd one out.
 */
export const E2EE_CLIENT_PREKEY_RECORD_KEY = "ryco.e2ee.clientPrekeyCertificate.v1";

/** Installation-scoped account-enrollment id; non-secret but must die with this custody namespace. */
export const E2EE_ACCOUNT_ENROLLMENT_ID_KEY = "ryco.e2ee.accountEnrollmentId.v1";

/** Public account-grant continuity metadata, isolated from locally verified trust records. */
export const E2EE_ACCOUNT_TRUST_DOCUMENT_KEY = "ryco.e2ee.accountTrustDocument.v1";

export type E2eeSecureStoreKey =
  | typeof E2EE_AGREEMENT_SECRET_KEY
  | typeof E2EE_TRUST_DOCUMENT_KEY
  | typeof E2EE_CLIENT_PREKEY_RECORD_KEY
  | typeof E2EE_ACCOUNT_ENROLLMENT_ID_KEY
  | typeof E2EE_ACCOUNT_TRUST_DOCUMENT_KEY;

/**
 * Every name in the namespace, in destruction order.
 *
 * Built from a record over the key union rather than written as an array
 * literal: TypeScript checks a record for exhaustiveness and cannot check an
 * array for it, so a name added to `E2eeSecureStoreKey` and not added here is a
 * compile error rather than an entry §6.3's purge silently leaves behind.
 */
const E2EE_SECURE_STORE_KEY_SET: Readonly<Record<E2eeSecureStoreKey, null>> = {
  [E2EE_AGREEMENT_SECRET_KEY]: null,
  [E2EE_TRUST_DOCUMENT_KEY]: null,
  [E2EE_CLIENT_PREKEY_RECORD_KEY]: null,
  [E2EE_ACCOUNT_ENROLLMENT_ID_KEY]: null,
  [E2EE_ACCOUNT_TRUST_DOCUMENT_KEY]: null,
};

export const E2EE_SECURE_STORE_KEYS = Object.keys(
  E2EE_SECURE_STORE_KEY_SET,
) as readonly E2eeSecureStoreKey[];

/**
 * Distinct from the bearer stores by construction: they pass no options at all,
 * so nothing this service names can collide with anything they wrote.
 */
export const E2EE_KEYCHAIN_SERVICE = "ryco.e2ee.v1";

/**
 * §6.3's storage class, which is a different attribute on each platform.
 *
 * iOS: `WHEN_UNLOCKED_THIS_DEVICE_ONLY` is both halves of the requirement in one
 * attribute — the item is readable only while the device is unlocked, and a
 * `ThisDeviceOnly` item is never placed in an encrypted backup, never restored
 * onto another device, and never synchronized to iCloud Keychain. It is refused
 * outright when it is not a number: the library's iOS default is `.whenUnlocked`,
 * which is NOT this-device-only, so a dropped constant would write private key
 * material into an item that backup and device transfer carry while looking like
 * it had asked for something stronger.
 *
 * Android: `keychainAccessible` IS AN iOS-ONLY OPTION and the constant that names
 * it is an iOS-only native constant — the Android module declares none, so
 * `SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY` is `undefined` there and requiring
 * it would refuse every E2EE operation on the platform. Android's half of §6.3 is
 * the non-exportable keystore key plus the backup and device-transfer exclusion
 * in `plugins/withAndroidSecureStoreBackupExclusion.cjs`.
 *
 * Anything else is refused. §6.3's only other row is web, whose private-key home
 * is process memory and which has no durable store at all.
 *
 * Read on first use rather than at module scope, because the constant comes from
 * the native module — and rebuilt on every call rather than cached, so a class
 * this file could not assert once is never assumed later.
 */
function e2eeSecureStoreOptions(): SecureStore.SecureStoreOptions {
  if (Platform.OS === "android") return { keychainService: E2EE_KEYCHAIN_SERVICE };
  if (Platform.OS !== "ios") throw new E2eeSecureStoreError();
  const keychainAccessible = SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY;
  if (typeof keychainAccessible !== "number") throw new E2eeSecureStoreError();
  return { keychainService: E2EE_KEYCHAIN_SERVICE, keychainAccessible };
}

/**
 * The plain, non-secure first-run marker (§6.3, clone and restore prohibition).
 *
 * It lives in the SQLite-backed KV precisely because that store dies with the
 * application container while keychain generic-password items survive deletion
 * and reinstall for the same bundle id. Marker absent while material is present
 * is therefore exactly the shape §6.3 forbids — a private agreement key that
 * outlived the installation that created it — and the response it mandates is to
 * destroy the material and require re-pairing (§13), not to adopt it.
 *
 * The value is a version rather than a flag so that adding a name to the
 * namespace can force one more purge instead of leaving an orphan behind.
 */
export const E2EE_INSTALL_MARKER_KEY = "ryco.e2ee.install.v1";
const E2EE_INSTALL_MARKER_VALUE = "1";

/** A bounded failure. Carries no key name, no service, and no native text. */
export class E2eeSecureStoreError extends Error {
  constructor() {
    super("Device key custody operation failed.");
    this.name = "E2eeSecureStoreError";
  }
}

/** The three calls this module makes, each with the options §6.3 requires. */
export interface E2eeSecureStoreLike {
  readonly getItemAsync: (
    key: string,
    options: SecureStore.SecureStoreOptions,
  ) => Promise<string | null>;
  readonly setItemAsync: (
    key: string,
    value: string,
    options: SecureStore.SecureStoreOptions,
  ) => Promise<void>;
  readonly deleteItemAsync: (key: string, options: SecureStore.SecureStoreOptions) => Promise<void>;
}

export interface E2eeSecureStore {
  readonly get: (key: E2eeSecureStoreKey) => Promise<string | null>;
  readonly set: (key: E2eeSecureStoreKey, value: string) => Promise<void>;
  readonly remove: (key: E2eeSecureStoreKey) => Promise<void>;
  /** Destroy every entry in the namespace (§6.3, §13 re-pairing). */
  readonly destroy: () => Promise<void>;
}

export interface E2eeSecureStoreDependencies {
  readonly store?: E2eeSecureStoreLike;
  readonly kv?: Pick<KVService, "getItem" | "setItem">;
}

/**
 * SecureStore keys are restricted to `[A-Za-z0-9._-]`, and `sanitizeSecretKey`
 * escapes everything outside `[A-Za-z0-9.-]` — including `_`, as `_005f`. Every
 * name above is already inside the passthrough set, so sanitizing is a no-op on
 * them; running it anyway means one sanitizer governs every secure-store key this
 * app writes, and `e2eeSecureStore.test.ts` pins the names as its fixed points so
 * a later name that needed escaping cannot slip in unnoticed.
 */
function storeKey(key: E2eeSecureStoreKey): string {
  return sanitizeSecretKey(key);
}

export function createE2eeSecureStore(
  dependencies: E2eeSecureStoreDependencies = {},
): E2eeSecureStore {
  const store = dependencies.store ?? SecureStore;
  const kv = dependencies.kv ?? mobileKV;

  const destroyEntries = async (): Promise<void> => {
    for (const key of E2EE_SECURE_STORE_KEYS) {
      await store.deleteItemAsync(storeKey(key), e2eeSecureStoreOptions());
    }
  };

  /**
   * §6.3's clone/restore check, run before the namespace is touched at all
   * (`installCustody.ts`). It forbids adopting a resurrected key "even while
   * its cross-signature remains unexpired", so no validity check may
   * short-circuit it. Until it completes, no accessor below reaches the store.
   */
  const ensureDeviceCustody = createInstallCustody({
    kv,
    markerKey: E2EE_INSTALL_MARKER_KEY,
    markerValue: E2EE_INSTALL_MARKER_VALUE,
    destroy: destroyEntries,
  });

  const bounded = async <A>(operation: () => Promise<A>): Promise<A> => {
    try {
      await ensureDeviceCustody();
      return await operation();
    } catch {
      // Native keychain and keystore errors carry status codes, item names, and
      // service names. None of that may reach a caller, a log, or a view.
      throw new E2eeSecureStoreError();
    }
  };

  return {
    get: (key) => bounded(() => store.getItemAsync(storeKey(key), e2eeSecureStoreOptions())),
    set: (key, value) =>
      bounded(() => store.setItemAsync(storeKey(key), value, e2eeSecureStoreOptions())),
    remove: (key) => bounded(() => store.deleteItemAsync(storeKey(key), e2eeSecureStoreOptions())),
    destroy: () => bounded(destroyEntries),
  };
}

export const mobileE2eeSecureStore = createE2eeSecureStore();
