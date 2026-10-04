import { describe, expect, it } from "vitest";
import {
  HUB_CONNECTOR_FAILURE_CODES,
  type HubConnectorState,
  type HubConnectorStatus,
  type HubIdentitySummary,
} from "@ryco/contracts";

import { canEditHubOrigin, presentHubStatus } from "./hubStatus.ts";

const NOW = Date.parse("2026-07-26T12:00:00.000Z");

const status = (overrides: Partial<HubConnectorStatus>): HubConnectorStatus =>
  ({
    state: "disabled",
    transitionedAt: "2026-07-26T11:59:00.000Z",
    activeChannels: 0,
    queuedBytes: 0,
    ...overrides,
  }) as HubConnectorStatus;

const identity = (enrolled: HubIdentitySummary["enrolled"]): HubIdentitySummary => ({ enrolled });

const ALL_STATES: readonly HubConnectorState[] = [
  "disabled",
  "enrolling",
  "awaiting_approval",
  "connecting",
  "authenticating",
  "online",
  "degraded",
  "revoked",
  "version_incompatible",
  "stopping",
];

describe("presentHubStatus", () => {
  it("produces copy for every state, including online", () => {
    for (const state of ALL_STATES) {
      const snapshot =
        state === "degraded"
          ? status({ state, degradedMode: "operator_action_required", failure: "internal_error" })
          : state === "online"
            ? status({ state, protocolMajor: 1, protocolMinor: 2 })
            : status({ state });
      const result = presentHubStatus(snapshot, identity("active"), NOW);
      expect(result.headline, state).toBeTruthy();
    }
  });

  it("produces copy for every operator-action failure code", () => {
    for (const failure of HUB_CONNECTOR_FAILURE_CODES) {
      const result = presentHubStatus(
        status({ state: "degraded", degradedMode: "operator_action_required", failure }),
        identity("active"),
        NOW,
      );
      expect(result.headline, failure).toBeTruthy();
      expect(result.retrying, failure).toBe(false);
    }
  });

  // The two pairs that motivated splitting the enum. If these ever collapse to
  // the same advice, the split has been undone somewhere.
  it("gives opposite advice for expiry versus denial", () => {
    const expired = presentHubStatus(
      status({
        state: "degraded",
        degradedMode: "operator_action_required",
        failure: "enrollment_expired",
      }),
      identity("pending"),
      NOW,
    );
    const denied = presentHubStatus(
      status({
        state: "degraded",
        degradedMode: "operator_action_required",
        failure: "enrollment_unavailable",
      }),
      identity("pending"),
      NOW,
    );
    expect(expired.headline).not.toBe(denied.headline);
    expect(denied.detail).toContain("declined");
  });

  it("offers retry for a locked keychain and restart for a dead one", () => {
    expect(
      presentHubStatus(
        status({
          state: "degraded",
          degradedMode: "operator_action_required",
          failure: "identity_unavailable",
        }),
        identity("active"),
        NOW,
      ).action,
    ).toBe("retry");
    // Resume provably cannot repair a construction failure, so offering it would
    // be a button that does nothing.
    expect(
      presentHubStatus(
        status({
          state: "degraded",
          degradedMode: "operator_action_required",
          failure: "identity_store_unavailable",
        }),
        identity("active"),
        NOW,
      ).action,
    ).toBe("restart");
  });

  it("distinguishes a never-enrolled node from an enrolled one that is switched off", () => {
    const off = status({ state: "disabled" });
    expect(presentHubStatus(off, identity("none"), NOW)).toMatchObject({
      headline: "Not connected",
      secondaryAction: "none",
    });
    // Status is identical; only the identity summary separates them.
    expect(presentHubStatus(off, identity("active"), NOW)).toMatchObject({
      headline: "Turned off",
      secondaryAction: "leave",
    });
  });

  it("marks backing_off as retrying and never asks the operator to act", () => {
    const result = presentHubStatus(
      status({
        state: "degraded",
        degradedMode: "backing_off",
        failure: "network_unavailable",
        reconnectAttempt: 5,
        nextRetryAt: "2026-07-26T12:00:24.000Z",
      }),
      identity("active"),
      NOW,
    );
    expect(result.retrying).toBe(true);
    expect(result.action).toBe("none");
    expect(result.detail).toContain("24s");
    expect(result.detail).toContain("attempt 5");
  });

  it("names a self-healing failure, says it is retrying, and still offers Retry", () => {
    for (const failure of [
      "identity_unavailable",
      "connection_replaced",
      "authentication_failed",
    ] as const) {
      const result = presentHubStatus(
        status({
          state: "degraded",
          degradedMode: "backing_off",
          failure,
          reconnectAttempt: 1,
          nextRetryAt: "2026-07-26T12:14:00.000Z",
        }),
        identity("active"),
        NOW,
      );
      // Not the generic "Reconnecting": a duplicate process or a removed node
      // must not hide behind an hour of quiet retries.
      expect(result.headline, failure).not.toBe("Reconnecting");
      expect(result.detail, failure).toContain("Retrying automatically in 14m");
      expect(result.retrying, failure).toBe(true);
      expect(result.dot, failure).toBe("warning");
      expect(result.action, failure).toBe("retry");
    }
  });

  it("never makes Leave the only way out of a rejected key", () => {
    for (const degradedMode of ["backing_off", "operator_action_required"] as const) {
      const result = presentHubStatus(
        status({ state: "degraded", degradedMode, failure: "authentication_failed" }),
        identity("active"),
        NOW,
      );
      expect(result.action, degradedMode).toBe("retry");
      // Still reachable for a node that really was removed on the Hub.
      expect(result.secondaryAction, degradedMode).toBe("leave");
    }
  });

  it("clamps a retry time that has already passed", () => {
    const result = presentHubStatus(
      status({
        state: "degraded",
        degradedMode: "backing_off",
        failure: "network_unavailable",
        nextRetryAt: "2026-07-26T11:59:00.000Z",
      }),
      identity("active"),
      NOW,
    );
    expect(result.detail).toContain("Retrying now");
  });

  // The same failure code in both a retrying and a non-retrying form: proof that
  // the code alone can never drive the button.
  it("presents protocol_invalid differently depending on degraded mode", () => {
    const retrying = presentHubStatus(
      status({ state: "degraded", degradedMode: "backing_off", failure: "protocol_invalid" }),
      identity("active"),
      NOW,
    );
    const stopped = presentHubStatus(
      status({
        state: "degraded",
        degradedMode: "operator_action_required",
        failure: "protocol_invalid",
      }),
      identity("active"),
      NOW,
    );
    expect(retrying.retrying).toBe(true);
    expect(stopped.retrying).toBe(false);
    expect(retrying.action).not.toBe(stopped.action);
  });

  it("says plainly that terminal states will not retry", () => {
    for (const state of ["revoked", "version_incompatible"] as const) {
      const result = presentHubStatus(status({ state }), identity("active"), NOW);
      expect(result.detail, state).toContain("will not retry");
      expect(result.retrying, state).toBe(false);
    }
  });

  it("counts sessions in the singular when there is one", () => {
    const one = presentHubStatus(
      status({ state: "online", protocolMajor: 1, protocolMinor: 2, activeChannels: 1 }),
      identity("active"),
      NOW,
    );
    expect(one.detail).toBe("1 active session");
  });
});

describe("canEditHubOrigin", () => {
  it("allows editing only when nothing is enrolled", () => {
    expect(canEditHubOrigin(identity("none"))).toBe(true);
    expect(canEditHubOrigin(identity("pending"))).toBe(false);
    expect(canEditHubOrigin(identity("active"))).toBe(false);
    // Fail-safe: an unreadable store may still hold an identity, and re-pointing
    // it would strand the node in a permanent origin mismatch.
    expect(canEditHubOrigin(identity("unknown"))).toBe(false);
  });
});
