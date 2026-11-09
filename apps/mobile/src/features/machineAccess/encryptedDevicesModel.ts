import type {
  HostedAccountActionStatus,
  HostedAccountE2eeDevice,
  HostedAccountOutcome,
} from "@ryco/client-runtime/authorization";
import {
  accountE2eeDeviceFacts,
  accountE2eeDevicePlatformLabel,
  accountE2eeDeviceStatusLabel,
  type AccountE2eeDeviceFact,
} from "@ryco/client-runtime/machineAccess/accountE2eeDevices";

/**
 * The Hub account's encrypted (native E2EE) devices, as the account screen
 * lists them: the same rows, facts and actions as the web's Encrypted devices
 * section. The Hub keeps the directory; renaming and revoking go through the
 * shared account controller, which re-reads it after each change.
 */

export type EncryptedDeviceDirectoryStatus = "idle" | "loading" | "ready" | "stale";

export interface EncryptedDeviceRow {
  readonly key: string;
  readonly device: HostedAccountE2eeDevice;
  readonly title: string;
  readonly detail: string;
  readonly statusLabel: string;
  readonly active: boolean;
  readonly facts: ReadonlyArray<AccountE2eeDeviceFact>;
  /** Rename and Revoke exist only for an active enrollment, and not while another change runs. */
  readonly canChange: boolean;
}

export interface EncryptedDevicesView {
  readonly rows: ReadonlyArray<EncryptedDeviceRow>;
  readonly empty: { readonly title: string; readonly detail: string } | null;
  readonly notice: string | null;
  readonly loading: boolean;
  readonly refreshDisabled: boolean;
  readonly renaming: boolean;
  readonly revoking: boolean;
}

export function deriveEncryptedDevicesView(input: {
  readonly devices: ReadonlyArray<HostedAccountE2eeDevice>;
  readonly status: EncryptedDeviceDirectoryStatus;
  readonly actionStatus: HostedAccountActionStatus;
  readonly formatTime: (epochMs: number) => string;
}): EncryptedDevicesView {
  const busy = input.actionStatus !== "idle";
  const loading = input.status === "loading";
  const rows = input.devices.map((device): EncryptedDeviceRow => {
    const active = device.status === "active";
    return {
      key: `${device.enrollmentId}:${String(device.enrollmentRevision)}`,
      device,
      title: device.deviceLabel,
      detail: `${accountE2eeDevicePlatformLabel(device)} · Ryco ${device.appVersion}`,
      statusLabel: accountE2eeDeviceStatusLabel(device),
      active,
      facts: accountE2eeDeviceFacts(device, input.formatTime),
      canChange: active && !busy,
    };
  });
  return {
    rows,
    empty:
      rows.length > 0
        ? null
        : {
            title: loading ? "Loading devices…" : "No native devices yet",
            detail:
              "Sign in from Ryco Desktop or mobile to enroll that app automatically. Web sessions stay separate and do not join this native device trust set.",
          },
    notice:
      input.status !== "stale"
        ? null
        : rows.length > 0
          ? "Showing the last device directory Ryco read."
          : "The device directory is temporarily unavailable.",
    loading,
    refreshDisabled: busy || loading,
    renaming: input.actionStatus === "renaming-e2ee-device",
    revoking: input.actionStatus === "revoking-e2ee-device",
  };
}

export function revokeEncryptedDeviceConfirm(deviceLabel: string) {
  return {
    title: "Revoke this encrypted device?",
    message:
      `${deviceLabel} will lose account-authorized native connections, and this enrollment ` +
      "cannot be restored. Enrolling it again takes a fresh sign-in on that device, and on a Hub " +
      "that cannot re-enroll a removed installation, a reinstall of Ryco there.",
    confirmText: "Revoke device",
  } as const;
}

export const RENAME_ENCRYPTED_DEVICE_COPY = {
  title: "Rename encrypted device",
  description:
    "This label is account metadata. Renaming does not rotate or replace the device keys.",
} as const;

/**
 * Turns a refused account action into a rejection, for a sheet that reports a
 * failed save by catching. The refusal's own message is on the account screen.
 */
export function requireCommitted(outcome: HostedAccountOutcome): void {
  if (outcome.status !== "committed") {
    throw new Error(outcome.errorMessage ?? "The Hub did not accept the change.");
  }
}
