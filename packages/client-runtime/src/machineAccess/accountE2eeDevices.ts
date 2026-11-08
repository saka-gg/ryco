import { NATIVE_E2EE_DEVICE_LABEL_MAX_CHARS } from "@ryco/contracts/native-e2ee";
import type { HostedAccountE2eeDevice } from "../authorization/types.ts";

export const ACCOUNT_E2EE_TRUST_EXPLANATION =
  "Signed-in native apps use these device keys to establish encrypted connections automatically. " +
  "The Hub authorizes account-trusted connections, so this does not protect against a malicious Hub; " +
  "independent node verification remains the stronger option.";

const PLATFORM_LABELS: Record<HostedAccountE2eeDevice["platform"], string> = {
  darwin: "macOS",
  linux: "Linux",
  windows: "Windows",
  ios: "iPhone or iPad",
  android: "Android",
};

const BACKING_LABELS: Record<HostedAccountE2eeDevice["reportedKeyBacking"], string> = {
  "secure-enclave": "Secure Enclave",
  strongbox: "StrongBox",
  tee: "Hardware-backed TEE",
  tpm: "TPM",
  "hardware-backed": "Hardware backed",
  unavailable: "Unavailable",
};

export function accountE2eeDevicePlatformLabel(device: HostedAccountE2eeDevice): string {
  return PLATFORM_LABELS[device.platform];
}

/** Web can report what a native client enrolled; it cannot remotely attest that claim. */
export function accountE2eeDeviceBackingLabel(device: HostedAccountE2eeDevice): string {
  return `${BACKING_LABELS[device.reportedKeyBacking]} · reported by device`;
}

export function accountE2eeDeviceStatusLabel(device: HostedAccountE2eeDevice): string {
  switch (device.status) {
    case "active":
      return "Active";
    case "revoked":
      return "Revoked";
    case "superseded":
      return "Superseded";
  }
}

export function normalizeAccountE2eeDeviceLabel(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= NATIVE_E2EE_DEVICE_LABEL_MAX_CHARS
    ? normalized
    : null;
}

export interface AccountE2eeDeviceFact {
  readonly label: string;
  readonly value: string;
  readonly fingerprint?: true;
}

export function accountE2eeDeviceFacts(
  device: HostedAccountE2eeDevice,
  formatTime: (value: number) => string,
): ReadonlyArray<AccountE2eeDeviceFact> {
  return [
    { label: "Enrollment", value: device.enrollmentId },
    { label: "Identity fingerprint", value: device.identityFingerprint, fingerprint: true },
    { label: "Agreement fingerprint", value: device.agreementFingerprint, fingerprint: true },
    { label: "Key backing", value: accountE2eeDeviceBackingLabel(device) },
    { label: "First enrolled", value: formatTime(device.createdAt) },
    {
      label: "Last used",
      value: device.lastUsedAt === null ? "Not used yet" : formatTime(device.lastUsedAt),
    },
    ...(device.revokedAt === null
      ? []
      : [{ label: "Revoked", value: formatTime(device.revokedAt) }]),
  ];
}
