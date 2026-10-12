import * as Crypto from "node:crypto";

import { verifyNativeTrustApprovalQr } from "@ryco/client-runtime/authorization/e2ee";
import { decodeBase64Url, encodeBase64Url } from "@ryco/client-runtime/relay";
import {
  e2eeBytesEqual,
  e2eeKeyFingerprint,
  formatE2eeKeyFingerprint,
  validateE2eeClientIdentityPublicKey,
  validateE2eeNodeIdentityPublicKey,
} from "@ryco/shared/relayE2eeKeys";
import type { NodeE2eeCapabilityVerification } from "@ryco/shared/relayE2eeCapabilityVerify";
import {
  decodeCrossDeviceApprovalQr,
  decodeCrossDeviceApprovalTbs,
} from "@ryco/shared/relayE2eeCrossDeviceApproval";

import type { DesktopProtectedRecordStore } from "./protectedRecordStore.ts";

const TRUST_RECORD = "e2ee-trust";
const TRUST_RECORDS_MAX = 64;
const BOUNDED_TEXT = 2_048;
const LOCAL_HANDLE = /^[A-Za-z0-9_-]{22}$/;

export type DesktopE2eeTrustErrorCode = "trust_unavailable" | "trust_conflict" | "trust_capacity";

export class DesktopE2eeTrustError extends Error {
  readonly code: DesktopE2eeTrustErrorCode;

  constructor(code: DesktopE2eeTrustErrorCode) {
    super("Desktop E2EE trust operation failed.");
    this.name = "DesktopE2eeTrustError";
    this.code = code;
  }
}

function fail(code: DesktopE2eeTrustErrorCode): never {
  throw new DesktopE2eeTrustError(code);
}

export interface DesktopVerifiedE2eePin {
  readonly hubOrigin: string;
  readonly accountId: string;
  readonly localNodeHandle: string;
  readonly nodeId: string;
  readonly environmentId: string;
  readonly verifiedFingerprint: string;
  readonly verifiedIdentityPublicKey: Uint8Array;
  readonly recordedContinuityId: string;
  readonly acceptedPolicyGeneration: number;
  readonly clientIdentityFingerprint: string;
  readonly approvedAt: number;
  readonly verificationMethod: "local-trusted-introduction-v1" | "cross-device-approval-v1";
}

interface StoredPin extends Omit<DesktopVerifiedE2eePin, "verifiedIdentityPublicKey"> {
  readonly verifiedIdentityPublicKey: string;
  readonly latchedAt: number;
}

interface StoredTrustDocument {
  readonly version: 1;
  readonly records: readonly StoredPin[];
  readonly verifiedMarkerOrigins: readonly string[];
}

const EMPTY: StoredTrustDocument = { version: 1, records: [], verifiedMarkerOrigins: [] };

function bounded(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= BOUNDED_TEXT;
}

function parsePin(value: unknown): StoredPin | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Partial<StoredPin>;
  if (
    !bounded(record.hubOrigin) ||
    !bounded(record.accountId) ||
    !bounded(record.nodeId) ||
    !bounded(record.environmentId) ||
    !bounded(record.verifiedFingerprint) ||
    !bounded(record.verifiedIdentityPublicKey) ||
    !bounded(record.recordedContinuityId) ||
    !bounded(record.clientIdentityFingerprint) ||
    !LOCAL_HANDLE.test(record.localNodeHandle ?? "") ||
    (record.verificationMethod !== "local-trusted-introduction-v1" &&
      record.verificationMethod !== "cross-device-approval-v1") ||
    !Number.isSafeInteger(record.acceptedPolicyGeneration) ||
    Number(record.acceptedPolicyGeneration) < 0 ||
    !Number.isSafeInteger(record.approvedAt) ||
    Number(record.approvedAt) < 0 ||
    record.latchedAt !== record.approvedAt
  ) {
    return null;
  }
  try {
    const publicKey = validateE2eeNodeIdentityPublicKey(
      decodeBase64Url(record.verifiedIdentityPublicKey),
    );
    if (
      formatE2eeKeyFingerprint(e2eeKeyFingerprint("node-identity", publicKey)) !==
      record.verifiedFingerprint
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return record as StoredPin;
}

function parseDocument(value: string | null): StoredTrustDocument {
  if (value === null) return EMPTY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return fail("trust_unavailable");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail("trust_unavailable");
  }
  const document = parsed as Partial<StoredTrustDocument>;
  if (
    document.version !== 1 ||
    !Array.isArray(document.records) ||
    document.records.length > TRUST_RECORDS_MAX ||
    !Array.isArray(document.verifiedMarkerOrigins) ||
    document.verifiedMarkerOrigins.some((origin) => !bounded(origin))
  ) {
    return fail("trust_unavailable");
  }
  const records = document.records.map(parsePin);
  if (records.some((record) => record === null)) return fail("trust_unavailable");
  const markers = [...new Set(document.verifiedMarkerOrigins)].toSorted();
  if (
    markers.length !== document.verifiedMarkerOrigins.length ||
    markers.some((origin, index) => origin !== document.verifiedMarkerOrigins?.[index])
  ) {
    return fail("trust_unavailable");
  }
  return { version: 1, records: records as StoredPin[], verifiedMarkerOrigins: markers };
}

function publicPin(record: StoredPin): DesktopVerifiedE2eePin {
  return {
    hubOrigin: record.hubOrigin,
    accountId: record.accountId,
    localNodeHandle: record.localNodeHandle,
    nodeId: record.nodeId,
    environmentId: record.environmentId,
    verifiedFingerprint: record.verifiedFingerprint,
    verifiedIdentityPublicKey: validateE2eeNodeIdentityPublicKey(
      decodeBase64Url(record.verifiedIdentityPublicKey),
    ),
    recordedContinuityId: record.recordedContinuityId,
    acceptedPolicyGeneration: record.acceptedPolicyGeneration,
    clientIdentityFingerprint: record.clientIdentityFingerprint,
    approvedAt: record.approvedAt,
    verificationMethod: record.verificationMethod,
  };
}

export class DesktopE2eeTrustStore {
  readonly #store: DesktopProtectedRecordStore;
  #pending: Promise<unknown> = Promise.resolve();

  constructor(store: DesktopProtectedRecordStore) {
    this.#store = store;
  }

  #exclusive<A>(operation: () => Promise<A>): Promise<A> {
    const run = this.#pending.then(operation, operation);
    this.#pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async read(
    hubOrigin: string,
    accountId: string,
    nodeId: string,
  ): Promise<DesktopVerifiedE2eePin | null> {
    const document = parseDocument(
      await this.#store.read(TRUST_RECORD).catch(() => fail("trust_unavailable")),
    );
    const matches = document.records.filter(
      (record) =>
        record.hubOrigin === hubOrigin &&
        record.accountId === accountId &&
        record.nodeId === nodeId,
    );
    return matches.length === 1 ? publicPin(matches[0]!) : null;
  }

  async list(hubOrigin: string, accountId: string): Promise<ReadonlyArray<DesktopVerifiedE2eePin>> {
    const document = parseDocument(
      await this.#store.read(TRUST_RECORD).catch(() => fail("trust_unavailable")),
    );
    return document.records
      .filter((record) => record.hubOrigin === hubOrigin && record.accountId === accountId)
      .map(publicPin);
  }

  async hasVerifiedOrigin(hubOrigin: string): Promise<boolean> {
    const document = parseDocument(
      await this.#store.read(TRUST_RECORD).catch(() => fail("trust_unavailable")),
    );
    return document.verifiedMarkerOrigins.includes(hubOrigin);
  }

  recordAuthenticatedStatement(input: {
    readonly hubOrigin: string;
    readonly accountId: string;
    readonly nodeId: string;
    readonly localNodeHandle: string;
    readonly verification: Extract<NodeE2eeCapabilityVerification, { readonly kind: "verified" }>;
  }): Promise<DesktopVerifiedE2eePin> {
    return this.#exclusive(async () => {
      if (input.verification.anchor === "none") return fail("trust_conflict");
      const document = parseDocument(
        await this.#store.read(TRUST_RECORD).catch(() => fail("trust_unavailable")),
      );
      const index = document.records.findIndex(
        (record) =>
          record.hubOrigin === input.hubOrigin &&
          record.accountId === input.accountId &&
          record.nodeId === input.nodeId &&
          record.localNodeHandle === input.localNodeHandle,
      );
      if (index < 0) return fail("trust_conflict");
      const existing = document.records[index]!;
      const statement = input.verification.statement;
      if (
        statement.hubOrigin !== input.hubOrigin ||
        statement.nodeId !== input.nodeId ||
        statement.continuityId !== existing.recordedContinuityId ||
        statement.policyGeneration < existing.acceptedPolicyGeneration
      ) {
        return fail("trust_conflict");
      }
      const nextPublicKey = validateE2eeNodeIdentityPublicKey(statement.identityPublicKey);
      const nextFingerprint = formatE2eeKeyFingerprint(
        e2eeKeyFingerprint("node-identity", nextPublicKey),
      );
      if (
        input.verification.anchor === "pin-unchanged" &&
        (nextFingerprint !== existing.verifiedFingerprint ||
          !e2eeBytesEqual(
            nextPublicKey,
            validateE2eeNodeIdentityPublicKey(decodeBase64Url(existing.verifiedIdentityPublicKey)),
          ))
      ) {
        return fail("trust_conflict");
      }
      const updated: StoredPin = {
        ...existing,
        verifiedFingerprint: nextFingerprint,
        verifiedIdentityPublicKey: encodeBase64Url(nextPublicKey),
        acceptedPolicyGeneration: statement.policyGeneration,
      };
      const records = [...document.records];
      records[index] = updated;
      await this.#store
        .write(TRUST_RECORD, JSON.stringify({ ...document, records }))
        .catch(() => fail("trust_unavailable"));
      return publicPin(updated);
    });
  }

  promoteLocal(input: {
    readonly hubOrigin: string;
    readonly accountId: string;
    readonly nodeId: string;
    readonly environmentId: string;
    readonly nodeIdentityPublicKey: Uint8Array;
    readonly nodeContinuityId: string;
    readonly nodePolicyGeneration: number;
    readonly clientIdentityPublicKey: Uint8Array;
    readonly approvedAt: number;
    readonly randomHandle?: () => string;
  }): Promise<DesktopVerifiedE2eePin> {
    return this.#promote({ ...input, verificationMethod: "local-trusted-introduction-v1" });
  }

  async promoteCrossDeviceApproval(input: {
    readonly payload: string;
    readonly hubOrigin: string;
    readonly accountId: string;
    readonly nodeId: string;
    readonly environmentId: string;
    readonly clientIdentityPublicKey: Uint8Array;
    readonly now: number;
    readonly randomHandle?: () => string;
  }): Promise<DesktopVerifiedE2eePin> {
    let advertised;
    try {
      advertised = decodeCrossDeviceApprovalTbs(decodeCrossDeviceApprovalQr(input.payload).tbs);
    } catch {
      return fail("trust_conflict");
    }
    const verification = verifyNativeTrustApprovalQr({
      payload: input.payload,
      hubOrigin: input.hubOrigin,
      accountId: input.accountId,
      nodeId: input.nodeId,
      nodeIdentityPublicKey: advertised.nodeIdentityPublicKey,
      clientIdentityPublicKey: input.clientIdentityPublicKey,
      nodeContinuityId: advertised.nodeContinuityId,
      nodePolicyGeneration: advertised.nodePolicyGeneration,
      now: input.now,
      requiredRole: "owner",
      requiredCapability: "ryco.rpc",
    });
    if (!verification.ok) return fail("trust_conflict");
    const { approval } = verification;
    return this.#promote({
      hubOrigin: input.hubOrigin,
      accountId: input.accountId,
      nodeId: input.nodeId,
      environmentId: input.environmentId,
      nodeIdentityPublicKey: approval.nodeIdentityPublicKey,
      nodeContinuityId: approval.nodeContinuityId,
      nodePolicyGeneration: approval.nodePolicyGeneration,
      clientIdentityPublicKey: input.clientIdentityPublicKey,
      approvedAt: approval.approvedAt,
      verificationMethod: "cross-device-approval-v1",
      ...(input.randomHandle ? { randomHandle: input.randomHandle } : {}),
    });
  }

  #promote(input: {
    readonly hubOrigin: string;
    readonly accountId: string;
    readonly nodeId: string;
    readonly environmentId: string;
    readonly nodeIdentityPublicKey: Uint8Array;
    readonly nodeContinuityId: string;
    readonly nodePolicyGeneration: number;
    readonly clientIdentityPublicKey: Uint8Array;
    readonly approvedAt: number;
    readonly verificationMethod: DesktopVerifiedE2eePin["verificationMethod"];
    readonly randomHandle?: () => string;
  }): Promise<DesktopVerifiedE2eePin> {
    return this.#exclusive(async () => {
      const nodeKey = validateE2eeNodeIdentityPublicKey(input.nodeIdentityPublicKey);
      const clientKey = validateE2eeClientIdentityPublicKey(input.clientIdentityPublicKey);
      if (
        !bounded(input.hubOrigin) ||
        !bounded(input.accountId) ||
        !bounded(input.nodeId) ||
        !bounded(input.environmentId) ||
        !bounded(input.nodeContinuityId) ||
        !Number.isSafeInteger(input.nodePolicyGeneration) ||
        input.nodePolicyGeneration < 0 ||
        !Number.isSafeInteger(input.approvedAt) ||
        input.approvedAt < 0
      ) {
        return fail("trust_conflict");
      }
      const document = parseDocument(
        await this.#store.read(TRUST_RECORD).catch(() => fail("trust_unavailable")),
      );
      const matches = document.records.filter(
        (record) =>
          record.hubOrigin === input.hubOrigin &&
          record.accountId === input.accountId &&
          record.nodeId === input.nodeId,
      );
      const expectedNodeFingerprint = formatE2eeKeyFingerprint(
        e2eeKeyFingerprint("node-identity", nodeKey),
      );
      const expectedClientFingerprint = formatE2eeKeyFingerprint(
        e2eeKeyFingerprint("client-identity", clientKey),
      );
      if (matches.length > 0) {
        if (matches.length !== 1) return fail("trust_conflict");
        const existing = publicPin(matches[0]!);
        if (
          existing.environmentId !== input.environmentId ||
          existing.verifiedFingerprint !== expectedNodeFingerprint ||
          !e2eeBytesEqual(existing.verifiedIdentityPublicKey, nodeKey) ||
          existing.recordedContinuityId !== input.nodeContinuityId ||
          existing.acceptedPolicyGeneration !== input.nodePolicyGeneration ||
          existing.clientIdentityFingerprint !== expectedClientFingerprint
        ) {
          return fail("trust_conflict");
        }
        return existing;
      }
      if (document.records.length >= TRUST_RECORDS_MAX) return fail("trust_capacity");
      const localNodeHandle = (
        input.randomHandle ?? (() => Crypto.randomBytes(16).toString("base64url"))
      )();
      if (!LOCAL_HANDLE.test(localNodeHandle)) return fail("trust_conflict");
      const stored: StoredPin = {
        hubOrigin: input.hubOrigin,
        accountId: input.accountId,
        localNodeHandle,
        nodeId: input.nodeId,
        environmentId: input.environmentId,
        verifiedFingerprint: expectedNodeFingerprint,
        verifiedIdentityPublicKey: encodeBase64Url(nodeKey),
        recordedContinuityId: input.nodeContinuityId,
        acceptedPolicyGeneration: input.nodePolicyGeneration,
        clientIdentityFingerprint: expectedClientFingerprint,
        approvedAt: input.approvedAt,
        latchedAt: input.approvedAt,
        verificationMethod: input.verificationMethod,
      };
      const markers = [...new Set([...document.verifiedMarkerOrigins, input.hubOrigin])].toSorted();
      await this.#store
        .write(
          TRUST_RECORD,
          JSON.stringify({
            version: 1,
            records: [...document.records, stored],
            verifiedMarkerOrigins: markers,
          }),
        )
        .catch(() => fail("trust_unavailable"));
      return publicPin(stored);
    });
  }
}
