import { decodeBase64Url, encodeBase64Url } from "@ryco/client-runtime/relay/base64url";
import {
  PushKeyId,
  PushPublicKey,
  type PushKeyId as PushKeyIdType,
  type PushPublicKey as PushPublicKeyType,
} from "@ryco/contracts/push";
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
  readonly deleteKey: () => Promise<void>;
}

interface NativePushKey {
  readonly publicKey: string;
  readonly enrollmentId: string | null;
}

export interface PushKey {
  readonly publicKey: PushPublicKeyType;
  readonly keyId: PushKeyIdType;
  /** The Hub enrollment alerts are opened with, as last recorded; null before the first. */
  readonly enrollmentId: string | null;
}

/** The push key as background alerts use it; tests pass their own. */
export interface PushKeyStore {
  readonly available: boolean;
  readonly ensureKey: () => Promise<PushKey>;
  readonly readKey: () => Promise<PushKey | null>;
  readonly setRegistration: (input: {
    readonly enrollmentId: string;
    readonly sound: boolean;
  }) => Promise<void>;
  readonly deleteKey: () => Promise<void>;
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

/** The store over the native module, or the unavailable one when there is none. */
export function createPushKeyStore(native: RycoPushNativeModule | null): PushKeyStore {
  if (native === null || !native.isAvailable()) return UNAVAILABLE_PUSH_KEY_STORE;
  return {
    available: true,
    ensureKey: async () => pushKeyOf(await native.ensureKey()),
    readKey: async () => {
      // A missing key crosses the bridge as null or undefined.
      const stored = await native.readKey();
      return stored ? pushKeyOf(stored) : null;
    },
    setRegistration: ({ enrollmentId, sound }) => native.setRegistration(enrollmentId, sound),
    deleteKey: () => native.deleteKey(),
  };
}
