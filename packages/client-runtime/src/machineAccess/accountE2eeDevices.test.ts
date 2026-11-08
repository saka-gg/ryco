import type { HostedAccountE2eeDevice } from "../authorization/types.ts";
import { describe, expect, it } from "vite-plus/test";

import {
  ACCOUNT_E2EE_TRUST_EXPLANATION,
  accountE2eeDeviceBackingLabel,
  accountE2eeDeviceFacts,
  accountE2eeDeviceStatusLabel,
  normalizeAccountE2eeDeviceLabel,
} from "./accountE2eeDevices.ts";

const device: HostedAccountE2eeDevice = {
  enrollmentId: `enr_${"e".repeat(22)}` as never,
  enrollmentRevision: 2 as never,
  accountAuthEpoch: 1 as never,
  deviceAuthEpoch: 1 as never,
  platform: "android",
  appVersion: "1.2.3",
  reportedKeyBacking: "tee",
  deviceLabel: "Travel phone",
  identityFingerprint: "i".repeat(43) as never,
  agreementFingerprint: "a".repeat(43) as never,
  clientPrekeyCertificateDigest: "c".repeat(43) as never,
  certificateExpiresAt: 2_000,
  status: "active",
  createdAt: 1_000,
  updatedAt: 1_500,
  lastUsedAt: 1_400,
  revokedAt: null,
};

describe("account E2EE device presentation", () => {
  it("labels remote hardware as reported and states the Hub trust ceiling", () => {
    expect(accountE2eeDeviceBackingLabel(device)).toBe("Hardware-backed TEE · reported by device");
    expect(ACCOUNT_E2EE_TRUST_EXPLANATION).toContain("does not protect against a malicious Hub");
    expect(ACCOUNT_E2EE_TRUST_EXPLANATION).toContain("independent node verification");
  });

  it("shows public enrollment history and fingerprints without grant material", () => {
    const facts = accountE2eeDeviceFacts(device, (value) => `time:${value}`);
    expect(facts).toEqual(
      expect.arrayContaining([
        { label: "Enrollment", value: device.enrollmentId },
        {
          label: "Identity fingerprint",
          value: device.identityFingerprint,
          fingerprint: true,
        },
        { label: "Last used", value: "time:1400" },
      ]),
    );
    expect(JSON.stringify(facts)).not.toMatch(/grant|ticket|certificateDigest/iu);
  });

  it("normalizes bounded labels and keeps terminal status distinct", () => {
    expect(normalizeAccountE2eeDeviceLabel("  Studio Mac  ")).toBe("Studio Mac");
    expect(normalizeAccountE2eeDeviceLabel(" ")).toBeNull();
    expect(normalizeAccountE2eeDeviceLabel("x".repeat(101))).toBeNull();
    expect(accountE2eeDeviceStatusLabel(device)).toBe("Active");
    expect(accountE2eeDeviceStatusLabel({ ...device, status: "revoked", revokedAt: 2_000 })).toBe(
      "Revoked",
    );
  });
});
