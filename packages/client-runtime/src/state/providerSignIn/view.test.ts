import { ProviderInstanceId, type ProviderSignInState } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { PROVIDER_SIGN_IN_FORBIDDEN, type ProviderSignInSnapshot } from "./controller.ts";
import {
  describeProviderSignIn,
  formatProviderSignInCountdown,
  isProviderSignInPageUrl,
  providerSignInOutcome,
  type ProviderSignInViewInput,
} from "./view.ts";

const INSTANCE = ProviderInstanceId.make("codex");

function state(patch: Partial<ProviderSignInState> = {}): ProviderSignInState {
  return {
    instanceId: INSTANCE,
    phase: "idle",
    flowId: null,
    method: "codexDeviceCode",
    unavailableReason: null,
    interaction: null,
    expiresAt: null,
    message: null,
    ...patch,
  };
}

function snapshot(patch: Partial<ProviderSignInSnapshot> = {}): ProviderSignInSnapshot {
  return {
    state: null,
    unsupported: false,
    forbidden: false,
    pending: null,
    error: null,
    interrupted: false,
    ...patch,
  };
}

function describeWith(patch: Partial<ProviderSignInViewInput> = {}) {
  const followed = patch.state === undefined ? state() : patch.state;
  return describeProviderSignIn({
    snapshot: snapshot({ state: followed }),
    state: followed,
    nodeLabel: "Studio",
    blockedReason: null,
    connected: true,
    canManage: true,
    instanceEnabled: true,
    ...patch,
  });
}

describe("describeProviderSignIn", () => {
  it("offers Sign in while the node can start one", () => {
    expect(describeWith()).toEqual({
      running: false,
      pending: null,
      unavailable: null,
      followFailed: false,
      canRetryFollow: false,
      canStart: true,
      canCancel: false,
      startLabel: "Sign in",
      error: null,
    });
    // The node says the instance cannot sign in from Ryco.
    expect(describeWith({ state: state({ method: null }) }).canStart).toBe(false);
    // Nothing reported yet.
    expect(describeWith({ state: null }).canStart).toBe(false);
  });

  it("names the first reason nothing can be done", () => {
    const blocked = describeWith({ blockedReason: "Reconnect to Studio.", connected: false });
    expect(blocked.unavailable).toBe("Reconnect to Studio.");
    expect(blocked.canStart).toBe(false);
    expect(describeWith({ connected: false, canManage: false }).unavailable).toBe(
      "Available when Studio is connected",
    );
    expect(describeWith({ canManage: false }).unavailable).toBe(PROVIDER_SIGN_IN_FORBIDDEN);
    expect(
      describeWith({ snapshot: snapshot({ forbidden: true, unsupported: true }) }).unavailable,
    ).toBe(PROVIDER_SIGN_IN_FORBIDDEN);
    expect(
      describeWith({ snapshot: snapshot({ unsupported: true }), instanceEnabled: false })
        .unavailable,
    ).toBe("Update Ryco on Studio to sign in from here.");
    expect(describeWith({ instanceEnabled: false }).unavailable).toBe(
      "Enable this provider instance to sign in.",
    );
  });

  it("cancels a running flow until it verifies the account", () => {
    const waiting = describeWith({ state: state({ phase: "waiting", flowId: "flow-1" }) });
    expect(waiting).toMatchObject({ running: true, canStart: false, canCancel: true });
    expect(describeWith({ state: state({ phase: "verifying", flowId: "flow-1" }) }).canCancel).toBe(
      false,
    );
    const cancelling = describeWith({
      state: state({ phase: "waiting", flowId: "flow-1" }),
      snapshot: snapshot({ pending: "cancel" }),
    });
    expect(cancelling).toMatchObject({ pending: "cancel", canCancel: false });
  });

  it("offers Try again after a flow ended without a sign-in", () => {
    for (const phase of ["failed", "expired", "cancelled"] as const) {
      expect(describeWith({ state: state({ phase, flowId: "flow-1" }) })).toMatchObject({
        canStart: true,
        startLabel: "Try again",
      });
    }
    expect(describeWith({ state: state({ phase: "succeeded", flowId: "flow-1" }) })).toMatchObject({
      canStart: true,
      startLabel: "Sign in",
    });
  });

  it("follows again when following failed before the node reported", () => {
    const failed = describeWith({
      state: null,
      snapshot: snapshot({ error: "Could not follow." }),
    });
    expect(failed).toMatchObject({
      followFailed: true,
      canRetryFollow: true,
      canStart: false,
      startLabel: "Try again",
      error: "Could not follow.",
    });
    // An error is not shown where nothing can be done anyway.
    expect(
      describeWith({
        state: null,
        snapshot: snapshot({ error: "Could not follow." }),
        connected: false,
      }),
    ).toMatchObject({ canRetryFollow: false, error: null });
  });
});

describe("providerSignInOutcome", () => {
  it("prefers the node's message", () => {
    expect(providerSignInOutcome(state({ phase: "failed", message: "Codex stopped." }))).toBe(
      "Codex stopped.",
    );
    expect(providerSignInOutcome(state({ phase: "expired" }))).toBe(
      "The sign-in expired. Start again.",
    );
    expect(providerSignInOutcome(state({ phase: "cancelled" }))).toBe("Sign-in cancelled.");
    expect(providerSignInOutcome(state({ phase: "failed" }))).toBe(
      "The sign-in failed. Try again.",
    );
  });
});

describe("formatProviderSignInCountdown", () => {
  it("counts down in minutes and seconds", () => {
    const now = Date.parse("2026-10-28T10:00:00.000Z");
    expect(formatProviderSignInCountdown("2026-10-28T10:15:00.000Z", now)).toBe("15:00");
    expect(formatProviderSignInCountdown("2026-10-28T10:01:30.500Z", now)).toBe("1:31");
    expect(formatProviderSignInCountdown("2026-10-28T09:59:59.000Z", now)).toBeNull();
    expect(formatProviderSignInCountdown("not a date", now)).toBeNull();
    expect(formatProviderSignInCountdown(null, now)).toBeNull();
  });
});

describe("isProviderSignInPageUrl", () => {
  it("opens https pages only", () => {
    expect(isProviderSignInPageUrl("https://auth.openai.com/codex/device")).toBe(true);
    expect(isProviderSignInPageUrl("http://example.com/device")).toBe(false);
    expect(isProviderSignInPageUrl("javascript:alert(1)")).toBe(false);
    expect(isProviderSignInPageUrl("not a url")).toBe(false);
  });
});
