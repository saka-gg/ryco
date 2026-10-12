import type {
  NativeE2eeAccountTrustedNode,
  NativeE2eePlatformService,
} from "@ryco/client-runtime/platform";
import { decodeBase64Url, encodeBase64Url } from "@ryco/client-runtime/relay/base64url";
import {
  e2eeBytesEqual,
  e2eeKeyFingerprint,
  e2eeSha256,
  validateE2eeAgreementPublicKey,
  validateE2eeClientIdentityPublicKey,
  validateE2eeNodeIdentityPublicKey,
} from "@ryco/shared/relayE2eeKeys";
import { encodeClientE2eePrekeyCertificateCarrier } from "@ryco/shared/relayE2eeTranscripts";
import { readMobileAppVersion, readMobileDeviceLabel, readMobileNativePlatform } from "./config";
import { getMobileDeviceIdentityPublicKey, getMobileDeviceKeyBacking } from "./deviceKey";
import { mobileE2eeAgreementKey } from "./e2eeAgreementKey";
import { mobileClientE2eePrekey } from "./e2eeClientPrekey";
import {
  E2EE_ACCOUNT_ENROLLMENT_ID_KEY,
  E2EE_ACCOUNT_TRUST_DOCUMENT_KEY,
  mobileE2eeSecureStore,
  type E2eeSecureStore,
} from "./e2eeSecureStore";
import { mobileNativeAuthorization } from "./nativeAuthorization";

const ENROLLMENT_ID = /^enr_[A-Za-z0-9_-]{22}$/u;
const MAX_RECORDS = 128;
const MAX_IDENTITY_CHANGES = 16;
const MAX_TEXT = 512;

export class MobileNativeE2eePlatformError extends Error {
  constructor() {
    super("Mobile native E2EE platform operation failed.");
    this.name = "MobileNativeE2eePlatformError";
  }
}

export interface MobileNativeE2eePlatformDependencies {
  readonly store?: E2eeSecureStore;
  readonly platform?: "ios" | "android";
  readonly appVersion?: string;
  readonly deviceLabel?: () => string;
  readonly randomBytes?: (length: number) => Promise<Uint8Array>;
  readonly ensureIdentity?: () => Promise<{
    readonly publicKey: Uint8Array;
    readonly backing: Awaited<ReturnType<typeof getMobileDeviceKeyBacking>>;
  }>;
  readonly ensureClientPrekey?: typeof mobileClientE2eePrekey.ensure;
  readonly withAgreementSecret?: NativeE2eePlatformService["withAgreementSecret"];
}

interface StoredAccountTrustDocument {
  readonly version: 1;
  readonly records: readonly {
    readonly hubOrigin: string;
    readonly accountId: string;
    readonly nodeId: string;
    readonly identityPublicKey: string;
    readonly identityFingerprint: string;
    readonly agreementFingerprint: string;
    readonly continuityId: string;
    readonly acceptedPolicyGeneration: number;
    readonly firstTrustedAt: number;
    readonly lastTrustedAt: number;
    readonly identityChanges?: readonly {
      readonly previousIdentityFingerprint: string;
      readonly nextIdentityFingerprint: string;
      readonly changedAt: number;
    }[];
  }[];
}

const EMPTY: StoredAccountTrustDocument = { version: 1, records: [] };

function bounded(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT;
}

function parseRecord(input: unknown): NativeE2eeAccountTrustedNode | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const value = input as StoredAccountTrustDocument["records"][number];
  if (
    !bounded(value?.hubOrigin) ||
    !bounded(value.accountId) ||
    !bounded(value.nodeId) ||
    !bounded(value.continuityId) ||
    !Number.isSafeInteger(value.acceptedPolicyGeneration) ||
    value.acceptedPolicyGeneration < 0 ||
    !Number.isSafeInteger(value.firstTrustedAt) ||
    value.firstTrustedAt < 0 ||
    !Number.isSafeInteger(value.lastTrustedAt) ||
    value.lastTrustedAt < value.firstTrustedAt
  ) {
    return null;
  }
  try {
    const identityPublicKey = validateE2eeNodeIdentityPublicKey(
      decodeBase64Url(value.identityPublicKey),
    );
    const identityFingerprint = decodeBase64Url(value.identityFingerprint);
    const agreementFingerprint = decodeBase64Url(value.agreementFingerprint);
    const identityChanges = (value.identityChanges ?? []).map((change) => ({
      previousIdentityFingerprint: decodeBase64Url(change.previousIdentityFingerprint),
      nextIdentityFingerprint: decodeBase64Url(change.nextIdentityFingerprint),
      changedAt: change.changedAt,
    }));
    if (
      !e2eeBytesEqual(
        identityFingerprint,
        e2eeKeyFingerprint("node-identity", identityPublicKey),
      ) ||
      identityFingerprint.byteLength !== 32 ||
      agreementFingerprint.byteLength !== 32 ||
      identityChanges.length > MAX_IDENTITY_CHANGES ||
      identityChanges.some(
        (change) =>
          change.previousIdentityFingerprint.byteLength !== 32 ||
          change.nextIdentityFingerprint.byteLength !== 32 ||
          !Number.isSafeInteger(change.changedAt) ||
          change.changedAt < value.firstTrustedAt ||
          change.changedAt > value.lastTrustedAt,
      )
    ) {
      return null;
    }
    return {
      ...value,
      identityPublicKey,
      identityFingerprint,
      agreementFingerprint,
      identityChanges,
    };
  } catch {
    return null;
  }
}

function parseDocument(value: string | null): readonly NativeE2eeAccountTrustedNode[] {
  if (value === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new MobileNativeE2eePlatformError();
  }
  const document = parsed as Partial<StoredAccountTrustDocument>;
  if (
    document?.version !== 1 ||
    !Array.isArray(document.records) ||
    document.records.length > MAX_RECORDS
  ) {
    throw new MobileNativeE2eePlatformError();
  }
  const records = document.records.map((record) => parseRecord(record));
  if (records.some((record) => record === null)) throw new MobileNativeE2eePlatformError();
  const unique = new Set(
    records.map((record) => `${record!.hubOrigin}\n${record!.accountId}\n${record!.nodeId}`),
  );
  if (unique.size !== records.length) throw new MobileNativeE2eePlatformError();
  return records as readonly NativeE2eeAccountTrustedNode[];
}

function storedRecord(record: NativeE2eeAccountTrustedNode) {
  return {
    ...record,
    identityPublicKey: encodeBase64Url(record.identityPublicKey),
    identityFingerprint: encodeBase64Url(record.identityFingerprint),
    agreementFingerprint: encodeBase64Url(record.agreementFingerprint),
    identityChanges: record.identityChanges.map((change) => ({
      previousIdentityFingerprint: encodeBase64Url(change.previousIdentityFingerprint),
      nextIdentityFingerprint: encodeBase64Url(change.nextIdentityFingerprint),
      changedAt: change.changedAt,
    })),
  };
}

export function createMobileNativeE2eePlatform(
  dependencies: MobileNativeE2eePlatformDependencies = {},
): NativeE2eePlatformService {
  const store = dependencies.store ?? mobileE2eeSecureStore;
  const randomBytes = dependencies.randomBytes ?? mobileNativeAuthorization.randomBytes;
  let writes: Promise<void> = Promise.resolve();
  const exclusive = <A>(run: () => Promise<A>): Promise<A> => {
    const result = writes.then(run, run);
    writes = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    platform: dependencies.platform ?? readMobileNativePlatform(),
    appVersion: dependencies.appVersion ?? readMobileAppVersion(),
    deviceLabel: dependencies.deviceLabel ?? readMobileDeviceLabel,
    randomBytes,
    ensureIdentity: async () => {
      const resolved = dependencies.ensureIdentity
        ? await dependencies.ensureIdentity()
        : {
            publicKey: await getMobileDeviceIdentityPublicKey(),
            backing: await getMobileDeviceKeyBacking(),
          };
      const publicKey = validateE2eeClientIdentityPublicKey(resolved.publicKey);
      return {
        publicKey,
        fingerprint: e2eeKeyFingerprint("client-identity", publicKey),
        backing: resolved.backing,
      };
    },
    ensureClientPrekey: async (namespace) => {
      const certificate = await (dependencies.ensureClientPrekey ?? mobileClientE2eePrekey.ensure)(
        namespace,
      );
      const agreementPublicKey = validateE2eeAgreementPublicKey(certificate.agreementPublicKey);
      const carrier = encodeClientE2eePrekeyCertificateCarrier(
        certificate.transcript,
        certificate.signature,
      );
      return {
        agreementPublicKey,
        agreementFingerprint: e2eeKeyFingerprint("agreement", agreementPublicKey),
        transcript: Uint8Array.from(certificate.transcript),
        signature: Uint8Array.from(certificate.signature),
        certificate: carrier,
        certificateDigest: e2eeSha256(carrier),
        expiresAt: certificate.expiresAt,
      };
    },
    getOrCreateEnrollmentId: () =>
      exclusive(async () => {
        const existing = await store.get(E2EE_ACCOUNT_ENROLLMENT_ID_KEY);
        if (existing !== null) {
          if (!ENROLLMENT_ID.test(existing)) throw new MobileNativeE2eePlatformError();
          return existing;
        }
        const id = `enr_${encodeBase64Url(await randomBytes(16))}`;
        if (!ENROLLMENT_ID.test(id)) throw new MobileNativeE2eePlatformError();
        await store.set(E2EE_ACCOUNT_ENROLLMENT_ID_KEY, id);
        return id;
      }),
    // This clears no installation material. The coordinator drops its in-memory
    // account scope, while the stable installation id and account-bound public
    // prekey certificate must survive sign-out so the next login restores the
    // same enrollment. `ensureClientPrekey` rejects/replaces a certificate for
    // a different namespace, and the secure-store reinstall marker destroys the
    // whole namespace when this is genuinely a new installation.
    clearEnrollment: () => exclusive(async () => undefined),
    withAgreementSecret:
      dependencies.withAgreementSecret ?? ((use) => mobileE2eeAgreementKey.withSecretKey(use)),
    readAccountTrustedNode: (scope) =>
      exclusive(async () => {
        const records = parseDocument(await store.get(E2EE_ACCOUNT_TRUST_DOCUMENT_KEY));
        return (
          records.find(
            (record) =>
              record.hubOrigin === scope.hubOrigin &&
              record.accountId === scope.accountId &&
              record.nodeId === scope.nodeId,
          ) ?? null
        );
      }),
    writeAccountTrustedNode: (record) =>
      exclusive(async () => {
        validateE2eeNodeIdentityPublicKey(record.identityPublicKey);
        if (record.agreementFingerprint.byteLength !== 32) {
          throw new MobileNativeE2eePlatformError();
        }
        if (
          record.identityChanges.length > MAX_IDENTITY_CHANGES ||
          record.identityChanges.some(
            (change) =>
              change.previousIdentityFingerprint.byteLength !== 32 ||
              change.nextIdentityFingerprint.byteLength !== 32 ||
              !Number.isSafeInteger(change.changedAt) ||
              change.changedAt < record.firstTrustedAt ||
              change.changedAt > record.lastTrustedAt,
          )
        ) {
          throw new MobileNativeE2eePlatformError();
        }
        const current = parseDocument(await store.get(E2EE_ACCOUNT_TRUST_DOCUMENT_KEY));
        const same = (candidate: NativeE2eeAccountTrustedNode) =>
          candidate.hubOrigin === record.hubOrigin &&
          candidate.accountId === record.accountId &&
          candidate.nodeId === record.nodeId;
        const existing = current.find(same);
        if (existing && record.acceptedPolicyGeneration < existing.acceptedPolicyGeneration) {
          throw new MobileNativeE2eePlatformError();
        }
        const next = [...current.filter((candidate) => !same(candidate)), record];
        if (next.length > MAX_RECORDS) throw new MobileNativeE2eePlatformError();
        const document: StoredAccountTrustDocument = {
          ...EMPTY,
          records: next.map(storedRecord),
        };
        await store.set(E2EE_ACCOUNT_TRUST_DOCUMENT_KEY, JSON.stringify(document));
      }),
  };
}

export const mobileNativeE2eePlatform = createMobileNativeE2eePlatform();
