import { decodeBase64Url, encodeBase64Url } from "@ryco/client-runtime/relay";
import {
  E2EE_MAX_CLOCK_SKEW,
  E2EE_PREKEY_LIFETIME,
  E2EE_PREKEY_ROTATION_OVERLAP,
} from "@ryco/shared/relayE2eeConstants";
import { E2EE_CLIENT_IDENTITY_ALGORITHM, verifyE2eeSignature } from "@ryco/shared/relayE2eeKeys";
import { encodeClientE2eePrekeyTranscript } from "@ryco/shared/relayE2eeTranscripts";

import type { DesktopLocalIntroductionSecurity } from "./localTrustedIntroduction.ts";
import type { DesktopProtectedRecordStore } from "./protectedRecordStore.ts";

const PREKEY_RECORD = "e2ee-client-prekey";

export interface DesktopE2eePrekeyCertificate {
  readonly hubOrigin: string;
  readonly accountId: string;
  readonly identityPublicKey: Uint8Array;
  readonly agreementPublicKey: Uint8Array;
  readonly transcript: Uint8Array;
  readonly signature: Uint8Array;
  readonly createdAt: number;
  readonly expiresAt: number;
}

interface StoredDesktopE2eePrekey {
  readonly hubOrigin: string;
  readonly accountId: string;
  readonly identityPublicKey: string;
  readonly agreementPublicKey: string;
  readonly signature: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export class DesktopE2eePrekeyError extends Error {
  readonly code = "prekey_unavailable" as const;

  constructor() {
    super("Desktop E2EE prekey operation failed.");
    this.name = "DesktopE2eePrekeyError";
  }
}

function fail(): never {
  throw new DesktopE2eePrekeyError();
}

function validity(
  certificate: Pick<DesktopE2eePrekeyCertificate, "createdAt" | "expiresAt">,
  now: number,
): "usable" | "renewable" | "expired" {
  if (now > certificate.expiresAt + E2EE_MAX_CLOCK_SKEW) return "expired";
  if (now + E2EE_MAX_CLOCK_SKEW < certificate.createdAt) return "expired";
  if (now + E2EE_PREKEY_ROTATION_OVERLAP >= certificate.expiresAt) return "renewable";
  return "usable";
}

function decodeStored(value: string | null): StoredDesktopE2eePrekey | null {
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Partial<StoredDesktopE2eePrekey>;
  if (
    typeof record.hubOrigin !== "string" ||
    record.hubOrigin.length === 0 ||
    typeof record.accountId !== "string" ||
    record.accountId.length === 0 ||
    typeof record.identityPublicKey !== "string" ||
    typeof record.agreementPublicKey !== "string" ||
    typeof record.signature !== "string" ||
    !Number.isSafeInteger(record.createdAt) ||
    Number(record.createdAt) < 0 ||
    !Number.isSafeInteger(record.expiresAt) ||
    Number(record.expiresAt) <= Number(record.createdAt) ||
    Number(record.expiresAt) - Number(record.createdAt) > E2EE_PREKEY_LIFETIME
  ) {
    return null;
  }
  return record as StoredDesktopE2eePrekey;
}

function certificateFromStored(
  stored: StoredDesktopE2eePrekey,
): DesktopE2eePrekeyCertificate | null {
  try {
    const identityPublicKey = decodeBase64Url(stored.identityPublicKey);
    const agreementPublicKey = decodeBase64Url(stored.agreementPublicKey);
    const signature = decodeBase64Url(stored.signature);
    const transcript = encodeClientE2eePrekeyTranscript({
      hubOrigin: stored.hubOrigin,
      accountId: stored.accountId,
      identityPublicKey,
      agreementPublicKey,
      createdAt: stored.createdAt,
      expiresAt: stored.expiresAt,
    });
    if (
      !verifyE2eeSignature({
        algorithm: E2EE_CLIENT_IDENTITY_ALGORITHM,
        publicKey: identityPublicKey,
        message: transcript,
        signature,
      })
    ) {
      return null;
    }
    return {
      hubOrigin: stored.hubOrigin,
      accountId: stored.accountId,
      identityPublicKey,
      agreementPublicKey,
      transcript,
      signature,
      createdAt: stored.createdAt,
      expiresAt: stored.expiresAt,
    };
  } catch {
    return null;
  }
}

/** Where the client's public keys are read from; see {@link DesktopClientPublicKeys}. */
export type DesktopClientPublicKeySource = Pick<
  DesktopLocalIntroductionSecurity,
  "getSigningPublicKey" | "ensureAgreementPublicKey"
> & {
  /** Calls `listener` when a key reset makes a read public key stale; returns the unsubscribe. */
  readonly onPublicKeysChanged?: (listener: () => void) => () => void;
};

/** One public key: read on first use, kept until cleared, handed out as a copy. */
class PublicKeyCell {
  readonly #read: () => Promise<Uint8Array>;
  #pending: Promise<Uint8Array> | undefined;

  constructor(read: () => Promise<Uint8Array>) {
    this.#read = read;
  }

  async get(): Promise<Uint8Array> {
    let pending = this.#pending;
    if (pending === undefined) {
      const read = this.#read();
      pending = read;
      this.#pending = read;
      // A failed read is not kept: the next caller asks the helper again.
      read.catch(() => {
        if (this.#pending === read) this.#pending = undefined;
      });
    }
    // A copy, so a caller that wipes its bytes cannot change what is kept.
    return Uint8Array.from(await pending);
  }

  clear(): void {
    this.#pending = undefined;
  }
}

/**
 * The client's signing and agreement public keys, read from the native security
 * helper once and kept for the life of the process. Every handshake and prekey
 * check needs them, and each read is a helper round trip (a process launch when
 * the helper is idle). Only public keys are kept: secrets are still borrowed
 * from the helper per handshake. A key reset reported by the source, or
 * {@link invalidate}, makes the next read ask the helper again.
 */
export class DesktopClientPublicKeys {
  readonly #signing: PublicKeyCell;
  readonly #agreement: PublicKeyCell;

  constructor(source: DesktopClientPublicKeySource) {
    this.#signing = new PublicKeyCell(() => source.getSigningPublicKey());
    this.#agreement = new PublicKeyCell(() => source.ensureAgreementPublicKey());
    source.onPublicKeysChanged?.(() => this.invalidate());
  }

  /** The uncompressed P-256 signing public key. */
  signing(): Promise<Uint8Array> {
    return this.#signing.get();
  }

  /** The X25519 agreement public key. */
  agreement(): Promise<Uint8Array> {
    return this.#agreement.get();
  }

  /** Forget both keys, so the next read asks the source again. */
  invalidate(): void {
    this.#signing.clear();
    this.#agreement.clear();
  }
}

const clientPublicKeys = new WeakMap<DesktopClientPublicKeySource, DesktopClientPublicKeys>();

/**
 * The public key memo of one security source. The prekey issuer and the
 * handshake service of a source share it, so a connect reads each key once.
 */
export function desktopClientPublicKeys(
  source: DesktopClientPublicKeySource,
): DesktopClientPublicKeys {
  let keys = clientPublicKeys.get(source);
  if (keys === undefined) {
    keys = new DesktopClientPublicKeys(source);
    clientPublicKeys.set(source, keys);
  }
  return keys;
}

export class DesktopE2eePrekeyIssuer {
  readonly #origin: string;
  readonly #security: DesktopLocalIntroductionSecurity;
  readonly #keys: DesktopClientPublicKeys;
  readonly #records: DesktopProtectedRecordStore;
  readonly #now: () => number;
  #pending: Promise<unknown> = Promise.resolve();

  constructor(input: {
    readonly origin: string;
    readonly security: DesktopLocalIntroductionSecurity & DesktopClientPublicKeySource;
    readonly records: DesktopProtectedRecordStore;
    readonly now?: () => number;
  }) {
    this.#origin = input.origin;
    this.#security = input.security;
    this.#keys = desktopClientPublicKeys(input.security);
    this.#records = input.records;
    this.#now = input.now ?? Date.now;
  }

  ensure(accountId: string): Promise<DesktopE2eePrekeyCertificate> {
    const operation = this.#pending.then(
      () => this.#ensure(accountId),
      () => this.#ensure(accountId),
    );
    this.#pending = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #ensure(accountId: string): Promise<DesktopE2eePrekeyCertificate> {
    try {
      const [identityPublicKey, agreementPublicKey, storedValue] = await Promise.all([
        this.#keys.signing(),
        this.#keys.agreement(),
        this.#records.read(PREKEY_RECORD),
      ]);
      const parsed = decodeStored(storedValue);
      const stored = parsed === null ? null : certificateFromStored(parsed);
      if (
        stored !== null &&
        stored.hubOrigin === this.#origin &&
        stored.accountId === accountId &&
        encodeBase64Url(stored.identityPublicKey) === encodeBase64Url(identityPublicKey) &&
        encodeBase64Url(stored.agreementPublicKey) === encodeBase64Url(agreementPublicKey) &&
        validity(stored, this.#now()) === "usable"
      ) {
        return stored;
      }

      const createdAt = this.#now();
      const expiresAt = createdAt + E2EE_PREKEY_LIFETIME;
      const transcript = encodeClientE2eePrekeyTranscript({
        hubOrigin: this.#origin,
        accountId,
        identityPublicKey,
        agreementPublicKey,
        createdAt,
        expiresAt,
      });
      const signature = await (await this.#security.getSigningKey()).sign(transcript);
      const certificate = {
        hubOrigin: this.#origin,
        accountId,
        identityPublicKey,
        agreementPublicKey,
        transcript,
        signature,
        createdAt,
        expiresAt,
      } satisfies DesktopE2eePrekeyCertificate;
      if (
        !verifyE2eeSignature({
          algorithm: E2EE_CLIENT_IDENTITY_ALGORITHM,
          publicKey: identityPublicKey,
          message: transcript,
          signature,
        })
      ) {
        return fail();
      }
      const encoded: StoredDesktopE2eePrekey = {
        hubOrigin: certificate.hubOrigin,
        accountId: certificate.accountId,
        identityPublicKey: encodeBase64Url(certificate.identityPublicKey),
        agreementPublicKey: encodeBase64Url(certificate.agreementPublicKey),
        signature: encodeBase64Url(certificate.signature),
        createdAt,
        expiresAt,
      };
      await this.#records.write(PREKEY_RECORD, JSON.stringify(encoded));
      return certificate;
    } catch (cause) {
      if (cause instanceof DesktopE2eePrekeyError) throw cause;
      return fail();
    }
  }
}
