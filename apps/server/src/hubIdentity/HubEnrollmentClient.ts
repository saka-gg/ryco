import { randomBytes } from "node:crypto";

import { canonicalizeHubOrigin } from "@ryco/shared/nodeIdentity";
import { E2EE_MAX_CLOCK_SKEW } from "@ryco/shared/relayE2eeConstants";

import type {
  ActiveHubNodeState,
  LocalHubIdentityStateStore,
  PendingHubEnrollmentState,
} from "./LocalHubIdentityState.ts";
import type { NodeSigningIdentity, NodeSigningPublicDescriptor } from "./NodeSigningIdentity.ts";
import type { ProtectedSecretStore } from "./ProtectedSecretStore.ts";

export interface HubEnrollmentMetadata {
  readonly label: string;
  readonly platformOs: "darwin" | "linux" | "windows" | "unknown";
  readonly platformArch: "arm64" | "x64" | "other";
  readonly clientVersion: string;
}

export interface HubEnrollmentStartRequest extends HubEnrollmentMetadata {
  readonly hubOrigin: string;
  readonly environmentId: string;
  readonly publicKey: NodeSigningPublicDescriptor;
}

export interface HubEnrollmentStartResponse {
  readonly deviceCode: string;
  readonly pollingSecret: Uint8Array;
  readonly expiresAt: number;
  readonly pollIntervalMs: number;
}

export type HubEnrollmentPollResponse =
  | { readonly status: "pending"; readonly retryAfterMs: number }
  | {
      readonly status: "approved";
      readonly nodeId: string;
      readonly environmentId: string;
      readonly activeKeyId: string;
      readonly enrolledAt: number;
    }
  | {
      readonly status: "unavailable";
      /**
       * Why the ceremony ended.
       *
       * `expired` is known locally from the ceremony's own expiry; `rejected`
       * covers denial or cancellation at the service. The two need opposite
       * operator instructions — start a new one versus find out who denied it —
       * so they must not collapse into a single code.
       */
      readonly reason: "expired" | "rejected";
    };

export interface HubEnrollmentTransport {
  readonly start: (request: HubEnrollmentStartRequest) => Promise<HubEnrollmentStartResponse>;
  readonly poll: (request: {
    readonly hubOrigin: string;
    readonly pollingSecret: Uint8Array;
  }) => Promise<HubEnrollmentPollResponse>;
}

export type HubEnrollmentClientErrorCode =
  | "enrollment_invalid_input"
  | "enrollment_conflict"
  | "enrollment_not_resumable"
  | "enrollment_response_invalid"
  | "enrollment_transport_failed"
  | "enrollment_local_state_failed";

export class HubEnrollmentClientError extends Error {
  readonly code: HubEnrollmentClientErrorCode;

  constructor(code: HubEnrollmentClientErrorCode) {
    super("Hub enrollment client operation failed.");
    this.name = "HubEnrollmentClientError";
    this.code = code;
  }
}

export interface StartedHubEnrollment {
  readonly deviceCode: string;
  readonly expiresAt: number;
  readonly pollIntervalMs: number;
  readonly environmentId: string;
  readonly publicKey: NodeSigningPublicDescriptor;
}

export interface HubEnrollmentClient {
  readonly start: (
    hubOrigin: string,
    metadata: HubEnrollmentMetadata,
  ) => Promise<StartedHubEnrollment>;
  readonly poll: (hubOrigin: string) => Promise<HubEnrollmentPollResponse>;
  readonly pollUntilTerminal: (hubOrigin: string) => Promise<HubEnrollmentPollResponse>;
  readonly cancel: (hubOrigin: string) => Promise<void>;
}

export interface HubEnrollmentClientDependencies {
  readonly transport: HubEnrollmentTransport;
  readonly signingIdentity: NodeSigningIdentity;
  readonly secretStore: ProtectedSecretStore;
  readonly stateStore: LocalHubIdentityStateStore;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const DEVICE_CODE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const NODE_ID = /^node_[A-Za-z0-9_-]{22,43}$/;
const NODE_KEY_ID = /^nkey_[A-Za-z0-9_-]{22}$/;
const MAX_POLL_ATTEMPTS = 120;

function clientError(code: HubEnrollmentClientErrorCode): never {
  throw new HubEnrollmentClientError(code);
}

function validateMetadata(metadata: HubEnrollmentMetadata): HubEnrollmentMetadata {
  if (
    typeof metadata.label !== "string" ||
    metadata.label !== metadata.label.trim() ||
    metadata.label.length < 1 ||
    metadata.label.length > 100 ||
    typeof metadata.clientVersion !== "string" ||
    metadata.clientVersion !== metadata.clientVersion.trim() ||
    metadata.clientVersion.length < 1 ||
    metadata.clientVersion.length > 64 ||
    !["darwin", "linux", "windows", "unknown"].includes(metadata.platformOs) ||
    !["arm64", "x64", "other"].includes(metadata.platformArch)
  ) {
    return clientError("enrollment_invalid_input");
  }
  return { ...metadata };
}

/**
 * A ceremony's `expiresAt` is stamped by the Hub's clock and compared with this machine's, so
 * both comparisons allow the same clock skew the relay protocol tolerates between node and Hub.
 * Without it a node whose clock runs ahead would refuse a fresh ceremony, or drop a live one
 * (and its pending key) before the Hub does. The Hub stays the authority on expiry: a poll after
 * the real end is answered `expired`.
 */
const ENROLLMENT_CLOCK_SKEW_ALLOWANCE_MS = E2EE_MAX_CLOCK_SKEW;

function validateStartResponse(
  response: HubEnrollmentStartResponse,
  now: number,
): HubEnrollmentStartResponse {
  if (
    !DEVICE_CODE.test(response.deviceCode) ||
    !(response.pollingSecret instanceof Uint8Array) ||
    response.pollingSecret.byteLength !== 32 ||
    !Number.isSafeInteger(response.expiresAt) ||
    response.expiresAt <= now - ENROLLMENT_CLOCK_SKEW_ALLOWANCE_MS ||
    response.expiresAt > now + 15 * 60_000 + ENROLLMENT_CLOCK_SKEW_ALLOWANCE_MS ||
    !Number.isSafeInteger(response.pollIntervalMs) ||
    response.pollIntervalMs < 1_000 ||
    response.pollIntervalMs > 60_000
  ) {
    return clientError("enrollment_response_invalid");
  }
  return {
    deviceCode: response.deviceCode,
    pollingSecret: Uint8Array.from(response.pollingSecret),
    expiresAt: response.expiresAt,
    pollIntervalMs: response.pollIntervalMs,
  };
}

function validatePollResponse(
  response: HubEnrollmentPollResponse,
  environmentId: string,
): HubEnrollmentPollResponse {
  if (response.status === "pending") {
    if (
      !Number.isSafeInteger(response.retryAfterMs) ||
      response.retryAfterMs < 1_000 ||
      response.retryAfterMs > 60_000
    ) {
      return clientError("enrollment_response_invalid");
    }
    return { status: "pending", retryAfterMs: response.retryAfterMs };
  }
  if (response.status === "approved") {
    if (
      !NODE_ID.test(response.nodeId) ||
      !NODE_KEY_ID.test(response.activeKeyId) ||
      response.environmentId !== environmentId ||
      !Number.isSafeInteger(response.enrolledAt) ||
      response.enrolledAt < 0
    ) {
      return clientError("enrollment_response_invalid");
    }
    return { ...response };
  }
  if (response.status === "unavailable") return response;
  return clientError("enrollment_response_invalid");
}

function activePollResult(
  active: ActiveHubNodeState,
  environmentId: string,
): HubEnrollmentPollResponse {
  return {
    status: "approved",
    nodeId: active.nodeId,
    environmentId,
    activeKeyId: active.activeKeyId,
    enrolledAt: active.enrolledAt,
  };
}

function randomSecretName(kind: "node-key" | "enrollment-poll"): string {
  return `${kind}.${randomBytes(16).toString("hex")}`;
}

export function makeHubEnrollmentClient(
  dependencies: HubEnrollmentClientDependencies,
): HubEnrollmentClient {
  const now = dependencies.now ?? Date.now;
  const sleep =
    dependencies.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  const clearPending = async (pending: PendingHubEnrollmentState): Promise<void> => {
    await dependencies.stateStore.update((current) => {
      if (
        current.pendingEnrollment?.keySecretName !== pending.keySecretName ||
        current.pendingEnrollment.pollingSecretName !== pending.pollingSecretName
      ) {
        return clientError("enrollment_local_state_failed");
      }
      return {
        ...current,
        revision: current.revision + 1,
        pendingEnrollment: { ...current.pendingEnrollment, cleanupRequested: true },
      };
    });
    await dependencies.secretStore.remove(pending.pollingSecretName);
    await dependencies.signingIdentity.delete(pending.keySecretName);
    await dependencies.stateStore.update((current) => {
      if (
        current.pendingEnrollment?.keySecretName !== pending.keySecretName ||
        current.pendingEnrollment.pollingSecretName !== pending.pollingSecretName ||
        !current.pendingEnrollment.cleanupRequested
      ) {
        return clientError("enrollment_local_state_failed");
      }
      return { ...current, revision: current.revision + 1, pendingEnrollment: null };
    });
  };

  const retryActiveCleanup = async (active: ActiveHubNodeState): Promise<void> => {
    if (active.cleanupPollingSecretName === null) return;
    await dependencies.secretStore.remove(active.cleanupPollingSecretName);
    await dependencies.stateStore.update((current) => {
      if (
        current.activeNode?.nodeId !== active.nodeId ||
        current.activeNode.cleanupPollingSecretName !== active.cleanupPollingSecretName
      ) {
        return clientError("enrollment_local_state_failed");
      }
      return {
        ...current,
        revision: current.revision + 1,
        activeNode: { ...current.activeNode, cleanupPollingSecretName: null },
      };
    });
  };

  const start: HubEnrollmentClient["start"] = async (rawHubOrigin, rawMetadata) => {
    let hubOrigin: string;
    try {
      hubOrigin = canonicalizeHubOrigin(rawHubOrigin);
    } catch {
      return clientError("enrollment_invalid_input");
    }
    const metadata = validateMetadata(rawMetadata);
    const initial = await dependencies.stateStore.readOrCreate();
    if (initial.activeNode !== null || initial.pendingEnrollment !== null) {
      return clientError("enrollment_conflict");
    }

    const keySecretName = randomSecretName("node-key");
    const pollingSecretName = randomSecretName("enrollment-poll");
    const publicKey = await dependencies.signingIdentity.generate(keySecretName);
    const createdAt = now();
    const pending: PendingHubEnrollmentState = {
      kind: "device-code",
      hubOrigin,
      keySecretName,
      pollingSecretName,
      label: metadata.label,
      // Unknown until the start response arrives; filled in by the commit below.
      deviceCode: null,
      createdAt,
      expiresAt: null,
      pollIntervalMs: null,
      cleanupRequested: false,
    };
    try {
      await dependencies.stateStore.update((current) => {
        if (current.activeNode !== null || current.pendingEnrollment !== null) {
          return clientError("enrollment_conflict");
        }
        return {
          ...current,
          revision: current.revision + 1,
          pendingEnrollment: pending,
        };
      });
    } catch (error: unknown) {
      await dependencies.signingIdentity.delete(keySecretName).catch(() => undefined);
      throw error;
    }

    let rawResponse: HubEnrollmentStartResponse | undefined;
    let response: HubEnrollmentStartResponse | undefined;
    try {
      rawResponse = await dependencies.transport.start({
        hubOrigin,
        environmentId: initial.environmentId,
        publicKey,
        ...metadata,
      });
      response = validateStartResponse(rawResponse, now());
    } catch (error: unknown) {
      rawResponse?.pollingSecret.fill(0);
      await clearPending(pending).catch(() => undefined);
      if (error instanceof HubEnrollmentClientError) throw error;
      return clientError("enrollment_transport_failed");
    }
    try {
      await dependencies.secretStore.create(pollingSecretName, response.pollingSecret);
      await dependencies.stateStore.update((current) => {
        if (current.pendingEnrollment?.keySecretName !== keySecretName) {
          return clientError("enrollment_local_state_failed");
        }
        return {
          ...current,
          revision: current.revision + 1,
          pendingEnrollment: {
            ...pending,
            deviceCode: response?.deviceCode ?? null,
            expiresAt: response?.expiresAt ?? null,
            pollIntervalMs: response?.pollIntervalMs ?? null,
          },
        };
      });
    } catch {
      await clearPending(pending).catch(() => undefined);
      return clientError("enrollment_local_state_failed");
    } finally {
      response?.pollingSecret.fill(0);
      if (rawResponse?.pollingSecret !== response?.pollingSecret) {
        rawResponse?.pollingSecret.fill(0);
      }
    }
    if (response === undefined) return clientError("enrollment_transport_failed");
    return {
      deviceCode: response.deviceCode,
      expiresAt: response.expiresAt,
      pollIntervalMs: response.pollIntervalMs,
      environmentId: initial.environmentId,
      publicKey,
    };
  };

  const poll: HubEnrollmentClient["poll"] = async (rawHubOrigin) => {
    let hubOrigin: string;
    try {
      hubOrigin = canonicalizeHubOrigin(rawHubOrigin);
    } catch {
      return clientError("enrollment_invalid_input");
    }
    const state = await dependencies.stateStore.readOrCreate();
    if (state.activeNode?.hubOrigin === hubOrigin) {
      await retryActiveCleanup(state.activeNode).catch(() => undefined);
      return activePollResult(state.activeNode, state.environmentId);
    }
    const pending = state.pendingEnrollment;
    if (
      pending === null ||
      (pending.kind ?? "device-code") !== "device-code" ||
      pending.hubOrigin !== hubOrigin ||
      pending.expiresAt === null ||
      pending.pollIntervalMs === null
    ) {
      return clientError("enrollment_not_resumable");
    }
    if (pending.cleanupRequested) {
      await clearPending(pending).catch(() => clientError("enrollment_local_state_failed"));
      return { status: "unavailable", reason: "rejected" };
    }
    if (now() >= pending.expiresAt + ENROLLMENT_CLOCK_SKEW_ALLOWANCE_MS) {
      await clearPending(pending).catch(() => clientError("enrollment_local_state_failed"));
      return { status: "unavailable", reason: "expired" };
    }
    const pollingSecret = await dependencies.secretStore.get(pending.pollingSecretName);
    if (pollingSecret === null || pollingSecret.byteLength !== 32) {
      pollingSecret?.fill(0);
      return clientError("enrollment_not_resumable");
    }
    let response: HubEnrollmentPollResponse;
    try {
      response = validatePollResponse(
        await dependencies.transport.poll({ hubOrigin, pollingSecret }),
        state.environmentId,
      );
    } catch (error: unknown) {
      if (error instanceof HubEnrollmentClientError) throw error;
      return clientError("enrollment_transport_failed");
    } finally {
      pollingSecret.fill(0);
    }

    if (response.status === "pending") return response;
    if (response.status === "unavailable") {
      await clearPending(pending).catch(() => clientError("enrollment_local_state_failed"));
      return response;
    }

    const activeNode: ActiveHubNodeState = {
      hubOrigin,
      nodeId: response.nodeId,
      activeKeyId: response.activeKeyId,
      activeKeySecretName: pending.keySecretName,
      cleanupPollingSecretName: pending.pollingSecretName,
      enrolledAt: response.enrolledAt,
    };
    const committed = await dependencies.stateStore.update((current) => {
      if (
        current.pendingEnrollment?.keySecretName !== pending.keySecretName ||
        current.pendingEnrollment.cleanupRequested
      ) {
        if (current.activeNode?.nodeId === response.nodeId) {
          return { ...current, revision: current.revision + 1 };
        }
        return clientError("enrollment_local_state_failed");
      }
      return {
        ...current,
        revision: current.revision + 1,
        pendingEnrollment: null,
        activeNode,
      };
    });
    if (committed.activeNode === null) return clientError("enrollment_local_state_failed");
    await retryActiveCleanup(committed.activeNode).catch(() => undefined);
    return activePollResult(committed.activeNode, committed.environmentId);
  };

  const pollUntilTerminal: HubEnrollmentClient["pollUntilTerminal"] = async (hubOrigin) => {
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
      const response = await poll(hubOrigin);
      if (response.status !== "pending") return response;
      await sleep(response.retryAfterMs);
    }
    return clientError("enrollment_not_resumable");
  };

  const cancel: HubEnrollmentClient["cancel"] = async (rawHubOrigin) => {
    let hubOrigin: string;
    try {
      hubOrigin = canonicalizeHubOrigin(rawHubOrigin);
    } catch {
      return clientError("enrollment_invalid_input");
    }
    const state = await dependencies.stateStore.readOrCreate();
    const pending = state.pendingEnrollment;
    if (
      pending === null ||
      (pending.kind ?? "device-code") !== "device-code" ||
      pending.hubOrigin !== hubOrigin
    ) {
      return;
    }
    await clearPending(pending).catch(() => clientError("enrollment_local_state_failed"));
  };

  return { start, poll, pollUntilTerminal, cancel };
}
