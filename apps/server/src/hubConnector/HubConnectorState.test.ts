import { generateKeyPairSync } from "node:crypto";

import type {
  RelayE2eeEnrollmentRevokedFrame,
  RelayE2eeVerifierKeysFrame,
} from "@ryco/contracts/relay";
import { E2EE_MAX_CLOCK_SKEW } from "@ryco/shared/relayE2eeConstants";
import { e2eeSha256 } from "@ryco/shared/relayE2eeKeys";
import { describe, expect, it } from "vite-plus/test";

import type { NodeE2eeAdvertisement } from "../hubIdentity/NodeE2eeCapabilityStatement.ts";
import {
  classifyConnectorFailure,
  HubConnectorE2eeStateMachine,
  HubConnectorStateMachine,
} from "./HubConnectorState.ts";

const HUB_ORIGIN = "https://hub.example";

function ed25519PublicKey(): Uint8Array {
  const key = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
  return Uint8Array.from(key.subarray(key.byteLength - 32));
}

function advertisement(statementByte: number, expiresAt: number): NodeE2eeAdvertisement {
  const statement = Uint8Array.of(statementByte);
  return {
    hubOrigin: HUB_ORIGIN,
    statement,
    statementDigest: e2eeSha256(statement),
    expiresAt,
  } as NodeE2eeAdvertisement;
}

function verifierKeys(
  generation: number,
  intervals: readonly (readonly [number, number])[],
): RelayE2eeVerifierKeysFrame {
  return {
    type: "e2ee.verifier-keys",
    protocolMajor: 1,
    protocolMinor: 3,
    generation,
    keys: intervals.map(([notBefore, notAfter], index) => ({
      keyId: `hgk_${String.fromCharCode(65 + index).repeat(22)}`,
      publicKey: ed25519PublicKey(),
      notBefore,
      notAfter,
    })),
  } as unknown as RelayE2eeVerifierKeysFrame;
}

describe("HubConnectorStateMachine", () => {
  it("serializes explicit states and rejects stale generations", () => {
    let now = Date.parse("2026-07-16T00:00:00.000Z");
    const state = new HubConnectorStateMachine(() => now);
    expect(state.snapshot().state).toBe("disabled");
    const first = state.beginGeneration();
    state.transition("connecting");
    now += 1_000;
    state.transition("authenticating");
    state.online({ protocolMajor: 1, protocolMinor: 2 });
    expect(state.snapshot()).toMatchObject({
      state: "online",
      protocolMajor: 1,
      protocolMinor: 2,
    });
    const second = state.invalidateGeneration();
    expect(state.isCurrent(first)).toBe(false);
    expect(state.isCurrent(second)).toBe(true);
    state.transition("stopping");
    state.transition("disabled");
  });

  it("rejects impossible transitions", () => {
    const state = new HubConnectorStateMachine(() => 0);
    expect(() => state.transition("online")).toThrow("Hub connector state transition is invalid.");
  });
});

describe("HubConnectorE2eeStateMachine", () => {
  it("requires minor 3, an exact current-generation ack, and a current verifier key", () => {
    let now = 1_000;
    const state = new HubConnectorE2eeStateMachine(() => now);
    const first = advertisement(1, 5_000);

    state.begin(1, HUB_ORIGIN, { protocolMajor: 1, protocolMinor: 2 });
    expect(state.publish(1, first)).toBe("invalid");

    state.begin(2, HUB_ORIGIN, { protocolMajor: 1, protocolMinor: 3 });
    expect(state.publish(1, first)).toBe("stale");
    expect(state.publish(2, first)).toBe("accepted");
    expect(state.acknowledge(3, first.statementDigest)).toBe("invalid");
    expect(state.acknowledge(2, new Uint8Array(32))).toBe("invalid");
    expect(state.replaceVerifierKeys(2, verifierKeys(1, [[0, 3_000]]))).toBe("accepted");
    expect(state.snapshot().accountGrantReady).toBe(false);
    expect(state.acknowledge(2, first.statementDigest)).toBe("accepted");
    expect(state.snapshot().accountGrantReady).toBe(true);

    const second = advertisement(2, 6_000);
    expect(state.publish(2, second)).toBe("accepted");
    expect(state.snapshot().accountGrantReady).toBe(false);
    expect(state.statementForDigest(2, first.statementDigest)).toBe(first);
    expect(state.accountGrantMaterial(2, first.statementDigest)?.advertisement).toBe(first);
    now = 5_000 + E2EE_MAX_CLOCK_SKEW + 1;
    expect(state.statementForDigest(2, first.statementDigest)).toBeUndefined();
    expect(state.accountGrantMaterial(2, first.statementDigest)).toBeUndefined();

    state.begin(3, HUB_ORIGIN, { protocolMajor: 1, protocolMinor: 3 });
    expect(state.snapshot()).toMatchObject({
      connectorGeneration: 3,
      currentStatementDigest: undefined,
      acknowledgedStatementDigest: undefined,
      verifierKeyset: undefined,
      accountGrantReady: false,
    });
  });

  it("validates key rotation overlap and returns detached snapshots", () => {
    const state = new HubConnectorE2eeStateMachine(() => 1_500);
    state.begin(7, HUB_ORIGIN, { protocolMajor: 1, protocolMinor: 3 });
    const initial = verifierKeys(4, [[1_000, 2_000]]);
    expect(state.replaceVerifierKeys(7, initial)).toBe("accepted");
    expect(state.replaceVerifierKeys(7, verifierKeys(3, [[1_000, 2_000]]))).toBe("stale");
    expect(
      state.replaceVerifierKeys(
        7,
        verifierKeys(5, [
          [1_000, 1_200],
          [1_300, 2_000],
        ]),
      ),
    ).toBe("invalid");
    expect(
      state.replaceVerifierKeys(
        7,
        verifierKeys(5, [
          [1_000, 1_600],
          [1_500, 2_500],
        ]),
      ),
    ).toBe("accepted");

    const snapshot = state.snapshot();
    snapshot.verifierKeyset!.keys[0]!.publicKey.fill(0);
    expect(state.snapshot().verifierKeyset!.keys[0]!.publicKey.some((byte) => byte !== 0)).toBe(
      true,
    );
  });

  it("delivers only monotonic revocation epochs for the current connector generation", () => {
    const state = new HubConnectorE2eeStateMachine(() => 1_000);
    state.begin(9, HUB_ORIGIN, { protocolMajor: 1, protocolMinor: 3 });
    const revocation = {
      type: "e2ee.enrollment-revoked",
      protocolMajor: 1,
      protocolMinor: 3,
      enrollmentId: `enr_${"E".repeat(22)}`,
      enrollmentRevision: 1,
      accountAuthEpoch: 2,
      deviceAuthEpoch: 3,
    } as RelayE2eeEnrollmentRevokedFrame;
    expect(state.acceptRevocation(8, revocation)).toBe("stale");
    expect(state.acceptRevocation(9, revocation)).toBe("accepted");
    expect(state.acceptRevocation(9, revocation)).toBe("stale");
    expect(
      state.acceptRevocation(9, {
        ...revocation,
        deviceAuthEpoch: 2,
      } as unknown as RelayE2eeEnrollmentRevokedFrame),
    ).toBe("stale");
    expect(
      state.acceptRevocation(9, {
        ...revocation,
        deviceAuthEpoch: 4,
      } as unknown as RelayE2eeEnrollmentRevokedFrame),
    ).toBe("accepted");
    expect(
      state.acceptRevocation(9, {
        ...revocation,
        enrollmentRevision: 2,
        deviceAuthEpoch: 1,
      } as unknown as RelayE2eeEnrollmentRevokedFrame),
    ).toBe("stale");
    expect(
      state.acceptRevocation(9, {
        ...revocation,
        enrollmentRevision: 2,
        deviceAuthEpoch: 4,
      } as unknown as RelayE2eeEnrollmentRevokedFrame),
    ).toBe("accepted");
    expect(
      state.enrollmentGrantIsCurrent({
        enrollmentId: revocation.enrollmentId,
        enrollmentRevision: 2,
        accountAuthEpoch: 2,
        deviceAuthEpoch: 5,
      }),
    ).toBe(false);
    expect(
      state.enrollmentGrantIsCurrent({
        enrollmentId: revocation.enrollmentId,
        enrollmentRevision: 3,
        accountAuthEpoch: 2,
        deviceAuthEpoch: 4,
      }),
    ).toBe(true);
  });
});

describe("classifyConnectorFailure", () => {
  it("classifies every transient failure for bounded automatic retry", () => {
    const cases = [
      ["dns", "network_unavailable"],
      ["network", "network_unavailable"],
      ["tls", "tls_unavailable"],
      ["authentication_timeout", "authentication_timeout"],
      ["server_draining", "server_draining"],
      ["rate_limited", "rate_limited"],
      ["heartbeat_timeout", "heartbeat_timeout"],
      ["slow_consumer", "slow_consumer"],
      ["internal_error", "internal_error"],
    ] as const;
    for (const [kind, failure] of cases) {
      expect(classifyConnectorFailure(kind, 0)).toEqual({ action: "retry", failure });
    }
  });

  it("stops only the failures no retry can fix", () => {
    for (const kind of [
      "configuration_invalid",
      "identity_store_unavailable",
      "identity_origin_mismatch",
      "enrollment_unavailable",
      "enrollment_expired",
    ] as const) {
      expect(classifyConnectorFailure(kind, 0)).toMatchObject({ action: "operator" });
    }
    expect(classifyConnectorFailure("revoked", 0)).toMatchObject({
      action: "operator",
      terminalState: "revoked",
    });
    expect(classifyConnectorFailure("version_incompatible", 0)).toMatchObject({
      action: "operator",
      terminalState: "version_incompatible",
    });
  });

  it("retries usually-transient identity, replacement, and refusal failures on their own clocks", () => {
    // A locked keychain is checked soon and is worth checking again on wake.
    expect(classifyConnectorFailure("identity_unavailable", 0)).toMatchObject({
      action: "slow_retry",
      failure: "identity_unavailable",
      policy: { baseDelayMs: 30_000, maxDelayMs: 600_000 },
      nudgeable: true,
    });
    // A duplicate is displaced by every retry, so the gap is long and capped.
    expect(classifyConnectorFailure("connection_replaced", 0)).toMatchObject({
      action: "slow_retry",
      failure: "connection_replaced",
      policy: { baseDelayMs: 300_000, maxPerHour: 3 },
      nudgeable: false,
    });
    expect(classifyConnectorFailure("authentication_failed", 0)).toMatchObject({
      action: "slow_retry",
      failure: "authentication_failed",
      policy: { baseDelayMs: 900_000, maxDelayMs: 3_600_000 },
      nudgeable: false,
    });
  });

  it("allows one backed-off canonical violation and stops the second before stability", () => {
    expect(classifyConnectorFailure("protocol_invalid", 0).action).toBe("retry");
    expect(classifyConnectorFailure("protocol_invalid", 1).action).toBe("operator");
  });

  it("retries one stale-proof rejection and treats the next as a real rejection", () => {
    expect(classifyConnectorFailure("authentication_stale", 0, 0)).toEqual({
      action: "retry",
      failure: "authentication_timeout",
    });
    expect(classifyConnectorFailure("authentication_stale", 0, 1)).toEqual(
      classifyConnectorFailure("authentication_failed", 0),
    );
  });
  it("keeps expiry distinguishable from denial, and a dead store from a locked one", () => {
    // Each pair needs opposite operator instructions, so collapsing either into
    // one code would make the panel give the wrong advice half the time.
    expect(classifyConnectorFailure("enrollment_expired", 0)).toEqual({
      action: "operator",
      failure: "enrollment_expired",
    });
    expect(classifyConnectorFailure("enrollment_unavailable", 0)).toEqual({
      action: "operator",
      failure: "enrollment_unavailable",
    });
    // A construction failure is latched for the process lifetime: resume cannot
    // repair it, so it must not read as the retryable locked-keychain case.
    expect(classifyConnectorFailure("identity_store_unavailable", 0)).toEqual({
      action: "operator",
      failure: "identity_store_unavailable",
    });
    expect(classifyConnectorFailure("identity_unavailable", 0)).toMatchObject({
      action: "slow_retry",
      failure: "identity_unavailable",
    });
  });
});
