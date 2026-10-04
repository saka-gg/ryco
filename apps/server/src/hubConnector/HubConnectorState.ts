import type {
  HubConnectorFailureCode,
  HubConnectorState,
  HubConnectorStatus,
} from "@ryco/contracts";
import {
  RELAY_ACCOUNT_GRANT_MINOR,
  RELAY_E2EE_GRANT_KEYSET_MAX_KEYS,
  type RelayE2eeEnrollmentRevokedFrame,
  type RelayE2eeVerifierKeysFrame,
  type RelayHubGrantVerificationKey,
  type RelayProtocolVersion,
} from "@ryco/contracts/relay";

import type { NodeE2eeAdvertisement } from "../hubIdentity/NodeE2eeCapabilityStatement.ts";
import {
  e2eeBytesEqual,
  e2eeSha256,
  validateE2eeNodeIdentityPublicKey,
} from "@ryco/shared/relayE2eeKeys";
import { E2EE_MAX_CLOCK_SKEW } from "@ryco/shared/relayE2eeConstants";

import {
  AUTHENTICATION_FAILED_RETRY,
  CONNECTION_REPLACED_RETRY,
  IDENTITY_UNAVAILABLE_RETRY,
  type SlowRetryPolicy,
} from "./ReconnectPolicy.ts";

export type ConnectorFailureKind =
  | "configuration_invalid"
  | "identity_unavailable"
  | "identity_store_unavailable"
  | "identity_origin_mismatch"
  | "enrollment_unavailable"
  | "enrollment_expired"
  | "dns"
  | "network"
  | "tls"
  | "authentication_timeout"
  | "authentication_failed"
  /** An `authentication_failed` for a proof old enough that its challenge may have expired. */
  | "authentication_stale"
  | "connection_replaced"
  | "server_draining"
  | "rate_limited"
  | "heartbeat_timeout"
  | "slow_consumer"
  | "protocol_invalid"
  | "revoked"
  | "version_incompatible"
  | "internal_error";

/**
 * What the connector does after a failure.
 *
 * `retry` is the ordinary capped backoff for failures that are transient by
 * nature. `slow_retry` is for failures that usually clear on their own but
 * could be real — a locked keychain, a duplicate process, a refused proof —
 * and retries on that failure's own long schedule instead of parking the node
 * until someone notices. `operator` is reserved for states no retry can fix:
 * configuration, a dead credential store, an origin mismatch, enrollment
 * outcomes, revocation, and an incompatible peer.
 */
export type ConnectorFailureDisposition =
  | { readonly action: "retry"; readonly failure: HubConnectorFailureCode }
  | {
      readonly action: "slow_retry";
      readonly failure: HubConnectorFailureCode;
      readonly policy: SlowRetryPolicy;
      /** Whether a wake or network change may bring the retry forward; see `HubConnector.nudge`. */
      readonly nudgeable: boolean;
    }
  | {
      readonly action: "operator";
      readonly failure: HubConnectorFailureCode;
      readonly terminalState?: "revoked" | "version_incompatible";
    };

export function classifyConnectorFailure(
  kind: ConnectorFailureKind,
  protocolViolationsBeforeStability: number,
  staleProofRetriesBeforeStability = 0,
): ConnectorFailureDisposition {
  switch (kind) {
    case "authentication_stale":
      // A fresh challenge is enough when the old one simply expired, so one
      // retry is free. A second stale rejection before the connection proves
      // stable is no longer evidence of a slow signature, and is treated as the
      // rejection it may well be.
      return staleProofRetriesBeforeStability === 0
        ? { action: "retry", failure: "authentication_timeout" }
        : classifyConnectorFailure("authentication_failed", protocolViolationsBeforeStability);
    case "dns":
    case "network":
      return { action: "retry", failure: "network_unavailable" };
    case "tls":
      return { action: "retry", failure: "tls_unavailable" };
    case "authentication_timeout":
      return { action: "retry", failure: "authentication_timeout" };
    case "server_draining":
      return { action: "retry", failure: "server_draining" };
    case "rate_limited":
      return { action: "retry", failure: "rate_limited" };
    case "heartbeat_timeout":
      return { action: "retry", failure: "heartbeat_timeout" };
    case "slow_consumer":
      return { action: "retry", failure: "slow_consumer" };
    case "internal_error":
      return { action: "retry", failure: "internal_error" };
    case "protocol_invalid":
      return protocolViolationsBeforeStability === 0
        ? { action: "retry", failure: "protocol_invalid" }
        : { action: "operator", failure: "protocol_invalid" };
    case "identity_unavailable":
      // A machine waking or a screen unlocking is exactly when a locked
      // keychain becomes readable, so those signals may bring this one forward.
      return {
        action: "slow_retry",
        failure: kind,
        policy: IDENTITY_UNAVAILABLE_RETRY,
        nudgeable: true,
      };
    case "connection_replaced":
      return {
        action: "slow_retry",
        failure: kind,
        policy: CONNECTION_REPLACED_RETRY,
        nudgeable: false,
      };
    case "authentication_failed":
      return {
        action: "slow_retry",
        failure: kind,
        policy: AUTHENTICATION_FAILED_RETRY,
        nudgeable: false,
      };
    // `identity_store_unavailable` is latched for the process lifetime: only a
    // restart rebuilds custody, so no retry can help.
    case "configuration_invalid":
    case "identity_store_unavailable":
    case "identity_origin_mismatch":
    case "enrollment_unavailable":
    case "enrollment_expired":
      return { action: "operator", failure: kind };
    case "revoked":
      return { action: "operator", failure: "authentication_failed", terminalState: "revoked" };
    case "version_incompatible":
      return {
        action: "operator",
        failure: "protocol_invalid",
        terminalState: "version_incompatible",
      };
  }
}

const transitions: Readonly<Record<HubConnectorState, ReadonlySet<HubConnectorState>>> = {
  disabled: new Set(["enrolling", "awaiting_approval", "connecting", "degraded", "stopping"]),
  enrolling: new Set(["awaiting_approval", "connecting", "degraded", "stopping", "disabled"]),
  awaiting_approval: new Set(["enrolling", "connecting", "degraded", "stopping", "disabled"]),
  connecting: new Set([
    "authenticating",
    "degraded",
    "revoked",
    "version_incompatible",
    "stopping",
    "disabled",
  ]),
  authenticating: new Set([
    "online",
    "degraded",
    "revoked",
    "version_incompatible",
    "stopping",
    "disabled",
  ]),
  online: new Set(["degraded", "revoked", "version_incompatible", "stopping", "disabled"]),
  degraded: new Set([
    "enrolling",
    "awaiting_approval",
    "connecting",
    "revoked",
    "version_incompatible",
    "stopping",
    "disabled",
  ]),
  revoked: new Set(["enrolling", "stopping", "disabled"]),
  version_incompatible: new Set(["connecting", "stopping", "disabled"]),
  stopping: new Set(["disabled"]),
};

export class HubConnectorStateMachine {
  readonly #now: () => number;
  #generation = 0;
  #status: HubConnectorStatus;

  constructor(now: () => number = Date.now) {
    this.#now = now;
    this.#status = {
      state: "disabled",
      transitionedAt: new Date(now()).toISOString(),
      activeChannels: 0,
      queuedBytes: 0,
    };
  }

  get generation(): number {
    return this.#generation;
  }

  snapshot(): HubConnectorStatus {
    return { ...this.#status };
  }

  beginGeneration(): number {
    this.#generation += 1;
    return this.#generation;
  }

  invalidateGeneration(): number {
    return this.beginGeneration();
  }

  isCurrent(generation: number): boolean {
    return generation === this.#generation;
  }

  transition(
    state: HubConnectorState,
    fields: Omit<
      HubConnectorStatus,
      "state" | "transitionedAt" | "activeChannels" | "queuedBytes"
    > & { readonly activeChannels?: number; readonly queuedBytes?: number } = {},
  ): HubConnectorStatus {
    if (state !== this.#status.state && !transitions[this.#status.state].has(state)) {
      throw new Error("Hub connector state transition is invalid.");
    }
    this.#status = {
      state,
      transitionedAt: new Date(this.#now()).toISOString(),
      activeChannels: fields.activeChannels ?? 0,
      queuedBytes: fields.queuedBytes ?? 0,
      ...(fields.degradedMode === undefined ? {} : { degradedMode: fields.degradedMode }),
      ...(fields.failure === undefined ? {} : { failure: fields.failure }),
      ...(fields.reconnectAttempt === undefined
        ? {}
        : { reconnectAttempt: fields.reconnectAttempt }),
      ...(fields.nextRetryAt === undefined ? {} : { nextRetryAt: fields.nextRetryAt }),
      ...(fields.protocolMajor === undefined ? {} : { protocolMajor: fields.protocolMajor }),
      ...(fields.protocolMinor === undefined ? {} : { protocolMinor: fields.protocolMinor }),
    };
    return this.snapshot();
  }

  online(
    protocol: { readonly protocolMajor: number; readonly protocolMinor: number },
    activeChannels = 0,
    queuedBytes = 0,
  ): HubConnectorStatus {
    return this.transition("online", {
      protocolMajor: protocol.protocolMajor,
      protocolMinor: protocol.protocolMinor,
      activeChannels,
      queuedBytes,
    });
  }

  updateOnlineMetrics(activeChannels: number, queuedBytes: number): HubConnectorStatus {
    if (this.#status.state !== "online") return this.snapshot();
    this.#status = { ...this.#status, activeChannels, queuedBytes };
    return this.snapshot();
  }
}

export interface HubConnectorE2eeVerifierKeyset {
  readonly hubOrigin: string;
  readonly connectorGeneration: number;
  readonly generation: number;
  readonly keys: readonly RelayHubGrantVerificationKey[];
}

export interface HubConnectorE2eeStatement {
  readonly connectorGeneration: number;
  readonly advertisement: NodeE2eeAdvertisement;
  readonly statementDigest: Uint8Array;
}

export interface HubConnectorAccountGrantMaterial {
  readonly hubOrigin: string;
  readonly connectorGeneration: number;
  readonly advertisement: NodeE2eeAdvertisement;
  readonly verifierKeys: readonly RelayHubGrantVerificationKey[];
}

export interface HubConnectorE2eeSnapshot {
  readonly hubOrigin: string | undefined;
  readonly connectorGeneration: number | undefined;
  readonly protocol: RelayProtocolVersion | undefined;
  readonly currentStatementDigest: Uint8Array | undefined;
  readonly acknowledgedStatementDigest: Uint8Array | undefined;
  readonly verifierKeyset: HubConnectorE2eeVerifierKeyset | undefined;
  readonly accountGrantReady: boolean;
}

export type HubConnectorE2eeUpdateResult = "accepted" | "stale" | "invalid";

const cloneVerifierKey = (key: RelayHubGrantVerificationKey): RelayHubGrantVerificationKey => ({
  ...key,
  publicKey: Uint8Array.from(key.publicKey),
});

const verifierKeyEqual = (
  left: RelayHubGrantVerificationKey,
  right: RelayHubGrantVerificationKey,
): boolean =>
  left.keyId === right.keyId &&
  left.notBefore === right.notBefore &&
  left.notAfter === right.notAfter &&
  e2eeBytesEqual(left.publicKey, right.publicKey);

/**
 * Generation-fenced E2EE control state for one authenticated Hub connector.
 *
 * A reconnect starts from nothing: neither an acknowledgement nor a verifier
 * key learned on an older socket can authorize an account-grant channel. The
 * class deliberately owns no persistence; the authenticated connector is the
 * source of truth and must republish/relearn all state after every generation.
 */
export class HubConnectorE2eeStateMachine {
  readonly #now: () => number;
  #hubOrigin: string | undefined;
  #connectorGeneration: number | undefined;
  #protocol: RelayProtocolVersion | undefined;
  #currentStatementDigest: Uint8Array | undefined;
  #acknowledgedStatementDigest: Uint8Array | undefined;
  #acknowledgedStatements = new Set<string>();
  #statements = new Map<string, HubConnectorE2eeStatement>();
  #verifierKeyset: HubConnectorE2eeVerifierKeyset | undefined;
  #revocations = new Map<string, RelayE2eeEnrollmentRevokedFrame>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  begin(connectorGeneration: number, hubOrigin: string, protocol: RelayProtocolVersion): void {
    this.clear();
    this.#connectorGeneration = connectorGeneration;
    this.#hubOrigin = hubOrigin;
    this.#protocol = { ...protocol };
  }

  clear(): void {
    this.#hubOrigin = undefined;
    this.#connectorGeneration = undefined;
    this.#protocol = undefined;
    this.#currentStatementDigest?.fill(0);
    this.#acknowledgedStatementDigest?.fill(0);
    this.#currentStatementDigest = undefined;
    this.#acknowledgedStatementDigest = undefined;
    this.#acknowledgedStatements.clear();
    this.#statements.clear();
    this.#verifierKeyset = undefined;
    this.#revocations.clear();
  }

  snapshot(): HubConnectorE2eeSnapshot {
    const currentStatementDigest = this.#currentStatementDigest;
    const acknowledgedStatementDigest = this.#acknowledgedStatementDigest;
    return {
      hubOrigin: this.#hubOrigin,
      connectorGeneration: this.#connectorGeneration,
      protocol: this.#protocol === undefined ? undefined : { ...this.#protocol },
      currentStatementDigest:
        currentStatementDigest === undefined ? undefined : Uint8Array.from(currentStatementDigest),
      acknowledgedStatementDigest:
        acknowledgedStatementDigest === undefined
          ? undefined
          : Uint8Array.from(acknowledgedStatementDigest),
      verifierKeyset: this.#cloneKeyset(),
      accountGrantReady: this.accountGrantReady(),
    };
  }

  publish(
    connectorGeneration: number,
    advertisement: NodeE2eeAdvertisement,
  ): HubConnectorE2eeUpdateResult {
    const generation = this.#generationResult(connectorGeneration);
    if (generation !== "accepted") return generation;
    if (
      this.#protocol?.protocolMinor !== RELAY_ACCOUNT_GRANT_MINOR ||
      advertisement.hubOrigin !== this.#hubOrigin ||
      advertisement.expiresAt <= this.#now()
    ) {
      return "invalid";
    }
    const statementDigest = e2eeSha256(advertisement.statement);
    if (!e2eeBytesEqual(statementDigest, advertisement.statementDigest)) return "invalid";
    const key = Buffer.from(statementDigest).toString("hex");
    this.#pruneStatements();
    this.#statements.set(key, {
      connectorGeneration,
      advertisement,
      statementDigest: Uint8Array.from(statementDigest),
    });
    this.#currentStatementDigest?.fill(0);
    this.#acknowledgedStatementDigest?.fill(0);
    this.#currentStatementDigest = Uint8Array.from(statementDigest);
    this.#acknowledgedStatementDigest = undefined;
    return "accepted";
  }

  clearStatement(connectorGeneration: number): HubConnectorE2eeUpdateResult {
    const generation = this.#generationResult(connectorGeneration);
    if (generation !== "accepted") return generation;
    this.#currentStatementDigest?.fill(0);
    this.#acknowledgedStatementDigest?.fill(0);
    this.#currentStatementDigest = undefined;
    this.#acknowledgedStatementDigest = undefined;
    return "accepted";
  }

  acknowledge(
    connectorGeneration: number,
    statementDigest: Uint8Array,
  ): HubConnectorE2eeUpdateResult {
    const generation = this.#generationResult(connectorGeneration);
    if (generation !== "accepted") return generation;
    if (
      this.#currentStatementDigest === undefined ||
      !e2eeBytesEqual(this.#currentStatementDigest, statementDigest)
    ) {
      return "invalid";
    }
    this.#acknowledgedStatementDigest?.fill(0);
    this.#acknowledgedStatementDigest = Uint8Array.from(statementDigest);
    this.#acknowledgedStatements.add(Buffer.from(statementDigest).toString("hex"));
    return "accepted";
  }

  replaceVerifierKeys(
    connectorGeneration: number,
    frame: RelayE2eeVerifierKeysFrame,
  ): HubConnectorE2eeUpdateResult {
    const generation = this.#generationResult(connectorGeneration);
    if (generation !== "accepted") return generation;
    if (
      this.#protocol?.protocolMinor !== RELAY_ACCOUNT_GRANT_MINOR ||
      !this.#validKeys(frame.keys)
    ) {
      return "invalid";
    }
    const previous = this.#verifierKeyset;
    if (previous !== undefined && frame.generation < previous.generation) return "stale";
    if (previous !== undefined && frame.generation === previous.generation) {
      return previous.keys.length === frame.keys.length &&
        previous.keys.every((key, index) => verifierKeyEqual(key, frame.keys[index]!))
        ? "accepted"
        : "invalid";
    }
    this.#verifierKeyset = {
      hubOrigin: this.#hubOrigin!,
      connectorGeneration,
      generation: frame.generation,
      keys: frame.keys.map(cloneVerifierKey),
    };
    return "accepted";
  }

  acceptRevocation(
    connectorGeneration: number,
    frame: RelayE2eeEnrollmentRevokedFrame,
  ): HubConnectorE2eeUpdateResult {
    const generation = this.#generationResult(connectorGeneration);
    if (generation !== "accepted") return generation;
    if (this.#protocol?.protocolMinor !== RELAY_ACCOUNT_GRANT_MINOR) return "invalid";
    const key = frame.enrollmentId as string;
    const previous = this.#revocations.get(key);
    if (previous !== undefined) {
      if (
        frame.accountAuthEpoch < previous.accountAuthEpoch ||
        frame.enrollmentRevision < previous.enrollmentRevision ||
        frame.deviceAuthEpoch < previous.deviceAuthEpoch ||
        (frame.accountAuthEpoch === previous.accountAuthEpoch &&
          frame.enrollmentRevision === previous.enrollmentRevision &&
          frame.deviceAuthEpoch === previous.deviceAuthEpoch)
      ) {
        return "stale";
      }
    }
    this.#revocations.set(key, {
      ...frame,
    });
    return "accepted";
  }

  statementForDigest(
    connectorGeneration: number,
    statementDigest: Uint8Array,
  ): NodeE2eeAdvertisement | undefined {
    if (!this.#isCurrent(connectorGeneration)) return undefined;
    this.#pruneStatements();
    const retained = this.#statements.get(Buffer.from(statementDigest).toString("hex"));
    if (
      retained === undefined ||
      !e2eeBytesEqual(e2eeSha256(retained.advertisement.statement), statementDigest) ||
      !e2eeBytesEqual(retained.advertisement.statementDigest, statementDigest)
    ) {
      return undefined;
    }
    return retained.advertisement;
  }

  accountGrantMaterial(
    connectorGeneration: number,
    statementDigest: Uint8Array,
  ): HubConnectorAccountGrantMaterial | undefined {
    if (!this.#isCurrent(connectorGeneration)) return undefined;
    const digestKey = Buffer.from(statementDigest).toString("hex");
    if (!this.#acknowledgedStatements.has(digestKey)) return undefined;
    const advertisement = this.statementForDigest(connectorGeneration, statementDigest);
    const keyset = this.#verifierKeyset;
    const at = this.#now();
    if (
      advertisement === undefined ||
      keyset === undefined ||
      !keyset.keys.some((key) => at >= key.notBefore && at < key.notAfter)
    ) {
      return undefined;
    }
    return {
      hubOrigin: this.#hubOrigin!,
      connectorGeneration,
      advertisement,
      verifierKeys: keyset.keys.map(cloneVerifierKey),
    };
  }

  enrollmentGrantIsCurrent(input: {
    readonly enrollmentId: string;
    readonly enrollmentRevision: number;
    readonly accountAuthEpoch: number;
    readonly deviceAuthEpoch: number;
  }): boolean {
    const revoked = this.#revocations.get(input.enrollmentId);
    if (revoked === undefined) return true;
    if (input.accountAuthEpoch < revoked.accountAuthEpoch) return false;
    if (input.deviceAuthEpoch < revoked.deviceAuthEpoch) return false;
    if (input.enrollmentRevision < revoked.enrollmentRevision) return false;
    // The event revokes the named revision, not merely grants below its epoch.
    // A higher revision is a new enrollment revision; the same revision stays
    // revoked even if a malicious/replayed envelope carries a larger epoch.
    return input.enrollmentRevision > revoked.enrollmentRevision;
  }

  accountGrantReady(): boolean {
    const at = this.#now();
    const current =
      this.#currentStatementDigest === undefined
        ? undefined
        : this.#statements.get(Buffer.from(this.#currentStatementDigest).toString("hex"));
    return (
      this.#protocol?.protocolMinor === RELAY_ACCOUNT_GRANT_MINOR &&
      current !== undefined &&
      current.advertisement.expiresAt + E2EE_MAX_CLOCK_SKEW >= at &&
      this.#acknowledgedStatementDigest !== undefined &&
      e2eeBytesEqual(current.statementDigest, this.#acknowledgedStatementDigest) &&
      this.#verifierKeyset?.keys.some((key) => at >= key.notBefore && at < key.notAfter) === true
    );
  }

  #isCurrent(connectorGeneration: number): boolean {
    return connectorGeneration === this.#connectorGeneration;
  }

  #generationResult(connectorGeneration: number): HubConnectorE2eeUpdateResult {
    if (this.#connectorGeneration === undefined) return "stale";
    if (connectorGeneration < this.#connectorGeneration) return "stale";
    if (connectorGeneration > this.#connectorGeneration) return "invalid";
    return "accepted";
  }

  #validKeys(keys: readonly RelayHubGrantVerificationKey[]): boolean {
    if (keys.length < 1 || keys.length > RELAY_E2EE_GRANT_KEYSET_MAX_KEYS) return false;
    if (new Set(keys.map((key) => key.keyId)).size !== keys.length) return false;
    try {
      for (const key of keys) {
        if (key.notAfter <= key.notBefore) return false;
        validateE2eeNodeIdentityPublicKey(key.publicKey);
      }
    } catch {
      return false;
    }
    const sorted = [...keys].sort((left, right) => left.notBefore - right.notBefore);
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index]!.notBefore > sorted[index - 1]!.notAfter) return false;
    }
    const at = this.#now();
    return keys.some((key) => at >= key.notBefore && at < key.notAfter);
  }

  #pruneStatements(): void {
    const at = this.#now();
    for (const [key, value] of this.#statements) {
      if (value.advertisement.expiresAt + E2EE_MAX_CLOCK_SKEW < at) {
        this.#statements.delete(key);
        this.#acknowledgedStatements.delete(key);
      }
    }
  }

  #cloneKeyset(): HubConnectorE2eeVerifierKeyset | undefined {
    const keyset = this.#verifierKeyset;
    return keyset === undefined
      ? undefined
      : {
          ...keyset,
          keys: keyset.keys.map(cloneVerifierKey),
        };
  }
}
