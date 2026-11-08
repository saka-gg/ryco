import type { HostedAccountE2eeDevice } from "@ryco/client-runtime/authorization";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveEncryptedDevicesView,
  requireCommitted,
  revokeEncryptedDeviceConfirm,
} from "./encryptedDevicesModel";

const device = {
  enrollmentId: `enr_${"e".repeat(22)}`,
  enrollmentRevision: 2,
  accountAuthEpoch: 1,
  deviceLabel: "Laurin's iPhone",
  platform: "ios",
  appVersion: "0.1.41",
  status: "active",
  reportedKeyBacking: "secure-enclave",
  identityFingerprint: "AAAA-BBBB",
  agreementFingerprint: "CCCC-DDDD",
  createdAt: Date.parse("2036-04-01T10:00:00.000Z"),
  lastUsedAt: null,
  revokedAt: null,
} as unknown as HostedAccountE2eeDevice;

const formatTime = (value: number) => new Date(value).toISOString();

describe("deriveEncryptedDevicesView", () => {
  it("lists each enrollment with its platform, version and facts", () => {
    const view = deriveEncryptedDevicesView({
      devices: [device],
      status: "ready",
      actionStatus: "idle",
      formatTime,
    });
    expect(view.empty).toBeNull();
    expect(view.rows[0]).toMatchObject({
      title: "Laurin's iPhone",
      detail: "iPhone or iPad · Ryco 0.1.41",
      statusLabel: "Active",
      active: true,
      canChange: true,
    });
    expect(view.rows[0]?.facts.map((fact) => fact.label)).toContain("Identity fingerprint");
  });

  it("holds every change while another account action runs", () => {
    const view = deriveEncryptedDevicesView({
      devices: [device],
      status: "ready",
      actionStatus: "revoking-e2ee-device",
      formatTime,
    });
    expect(view.rows[0]?.canChange).toBe(false);
    expect(view.revoking).toBe(true);
    expect(view.refreshDisabled).toBe(true);
  });

  it("offers nothing on a revoked enrollment", () => {
    const view = deriveEncryptedDevicesView({
      devices: [{ ...device, status: "revoked", revokedAt: 1 } as HostedAccountE2eeDevice],
      status: "ready",
      actionStatus: "idle",
      formatTime,
    });
    expect(view.rows[0]).toMatchObject({ statusLabel: "Revoked", active: false, canChange: false });
  });

  it("explains an empty, loading or stale directory", () => {
    expect(
      deriveEncryptedDevicesView({
        devices: [],
        status: "loading",
        actionStatus: "idle",
        formatTime,
      }).empty?.title,
    ).toBe("Loading devices…");
    expect(
      deriveEncryptedDevicesView({ devices: [], status: "stale", actionStatus: "idle", formatTime })
        .notice,
    ).toBe("The device directory is temporarily unavailable.");
    expect(
      deriveEncryptedDevicesView({
        devices: [device],
        status: "stale",
        actionStatus: "idle",
        formatTime,
      }).notice,
    ).toBe("Showing the last device directory Ryco read.");
  });
});

describe("encrypted device actions", () => {
  it("names the device and says the enrollment cannot come back", () => {
    const copy = revokeEncryptedDeviceConfirm("Laurin's iPhone");
    expect(copy.message).toContain("Laurin's iPhone");
    expect(copy.message).toContain("cannot be restored");
  });

  it("rejects a refused change so the sheet stays open", () => {
    expect(() => requireCommitted({ status: "committed" })).not.toThrow();
    expect(() =>
      requireCommitted({
        status: "refused",
        reason: "error",
        errorCode: null,
        wireErrorCode: null,
        inferredErrorCode: false,
        errorMessage: "Nope",
      } as never),
    ).toThrow("Nope");
  });
});
