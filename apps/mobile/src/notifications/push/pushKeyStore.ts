import type { PushKey, PushKeyStore } from "@ryco/client-runtime/notifications/push";
import { decodeBase64Url, encodeBase64Url } from "@ryco/client-runtime/relay/base64url";
import { PushKeyId, PushPublicKey } from "@ryco/contracts/push";
import { pushKeyIdBytes } from "@ryco/shared/pushSeal";
import * as Schema from "effect/Schema";

/**
 * The `RycoPush` native module (`modules/ryco-push`): the installation's
 * X25519 push key in the keychain group the app shares with its notification
 * service extension. Only the public key crosses into JavaScript.
 */
export interface RycoPushNativeModule {
  /** The build carries the extension and the shared keychain group. */
  readonly isAvailable: () => boolean;
  /** The key, created if absent: the raw 32-byte public key, base64url, and the recorded enrollment. */
  readonly ensureKey: () => Promise<NativePushKey>;
  /** The key if one exists; never creates one. */
  readonly readKey: () => Promise<NativePushKey | null>;
  /** Records what the extension opens alerts with: the Hub enrollment and the sound setting. */
  readonly setRegistration: (enrollmentId: string, sound: boolean) => Promise<void>;
  /** Deletes the key, and the alert excerpts the extension left (`AlertExcerptStore`). */
  readonly deleteKey: () => Promise<void>;
  /**
   * The excerpt record the extension left for a thread's latest approval or question alert, as
   * JSON (`alertExcerpts.ts` reads it). Absent from binaries older than excerpts.
   */
  readonly readAlertExcerpt?: (environmentId: string, threadId: string) => Promise<string | null>;
  /** Forgets a thread's excerpt. Absent from binaries older than excerpts. */
  readonly removeAlertExcerpt?: (environmentId: string, threadId: string) => Promise<void>;
  /**
   * The app icon badge (`PushBadgeStore`): writes the machines' live "needs you" counts over the
   * ones alerts brought, drops machines not in `listed`, sets the badge to the sum and answers it.
   * Absent from builds before the badge.
   */
  readonly setBadgeCounts?: (
    live: Readonly<Record<string, number>>,
    listed: ReadonlyArray<string>,
  ) => Promise<number>;
  /** Forgets every machine's count and clears the badge. Absent from builds before the badge. */
  readonly clearBadge?: () => Promise<void>;
}

interface NativePushKey {
  readonly publicKey: string;
  readonly enrollmentId: string | null;
}

const unavailable = () => Promise.reject(new Error("This build cannot receive background alerts."));

/** Android, a build without the extension, or a test: nothing to register. */
export const UNAVAILABLE_PUSH_KEY_STORE: PushKeyStore = {
  available: false,
  ensureKey: unavailable,
  readKey: () => Promise.resolve(null),
  setRegistration: unavailable,
  deleteKey: () => Promise.resolve(),
};

const decodePublicKey = Schema.decodeUnknownSync(PushPublicKey);
const decodeKeyId = Schema.decodeUnknownSync(PushKeyId);

/** A push key's id: the first 16 bytes of SHA-256 over the public key, base64url. */
export function pushKeyOf(native: NativePushKey): PushKey {
  const publicKey = decodePublicKey(native.publicKey);
  const bytes = decodeBase64Url(publicKey);
  if (bytes.byteLength !== 32) throw new Error("A push key is 32 bytes.");
  return {
    publicKey,
    keyId: decodeKeyId(encodeBase64Url(pushKeyIdBytes(bytes))),
    enrollmentId: typeof native.enrollmentId === "string" ? native.enrollmentId : null,
  };
}

/**
 * The store over the native module, or the unavailable one when there is none.
 * Every call waits for `custody` first: a key an earlier installation left is
 * gone before anything reads, records or registers one.
 */
export function createPushKeyStore(
  native: RycoPushNativeModule | null,
  custody: () => Promise<void>,
): PushKeyStore {
  if (native === null || !native.isAvailable()) return UNAVAILABLE_PUSH_KEY_STORE;
  const held =
    <A>(operation: () => Promise<A>) =>
    async (): Promise<A> => {
      await custody();
      return operation();
    };
  return {
    available: true,
    ensureKey: held(async () => pushKeyOf(await native.ensureKey())),
    readKey: held(async () => {
      // A missing key crosses the bridge as null or undefined.
      const stored = await native.readKey();
      return stored ? pushKeyOf(stored) : null;
    }),
    setRegistration: ({ enrollmentId, sound }) =>
      held(() => native.setRegistration(enrollmentId, sound))(),
    deleteKey: held(() => native.deleteKey()),
  };
}
