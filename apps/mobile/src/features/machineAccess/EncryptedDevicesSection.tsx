import type { HostedAccountE2eeDevice } from "@ryco/client-runtime/authorization";
import { ACCOUNT_E2EE_TRUST_EXPLANATION } from "@ryco/client-runtime/machineAccess/accountE2eeDevices";
import { NATIVE_E2EE_DEVICE_LABEL_MAX_CHARS } from "@ryco/contracts/native-e2ee";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { hostedHubController, useHostedAccountStore } from "../../hostedHub/state";
import { DeviceRenameSheet } from "../nodes/DeviceRenameSheet";
import {
  AccessQuietRow,
  AccessRow,
  AccessSection,
  ActionChip,
  LIVE_TONE,
  QUIET_TONE,
  type AccessRowAction,
} from "./MachineAccessParts";
import {
  deriveEncryptedDevicesView,
  RENAME_ENCRYPTED_DEVICE_COPY,
  requireCommitted,
  revokeEncryptedDeviceConfirm,
  type EncryptedDeviceRow,
} from "./encryptedDevicesModel";

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatEpoch(value: number): string {
  return timestampFormatter.format(new Date(value));
}

const NO_DEVICES: ReadonlyArray<HostedAccountE2eeDevice> = [];

/**
 * The Hub account's encrypted devices, for the account screen: each signed-in
 * native app's E2EE enrollment, with Rename and Revoke for an active one. A
 * row opens to its fingerprints and dates, which are what an owner compares
 * against the device itself.
 */
export function EncryptedDevicesSection() {
  const devices = useHostedAccountStore((state) => state.e2eeDevices ?? NO_DEVICES);
  const status = useHostedAccountStore((state) => state.e2eeDevicesStatus ?? "idle");
  const actionStatus = useHostedAccountStore((state) => state.actionStatus);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<HostedAccountE2eeDevice | null>(null);

  useEffect(() => {
    void hostedHubController.refreshE2eeDevices();
  }, []);

  const view = deriveEncryptedDevicesView({
    devices,
    status,
    actionStatus,
    formatTime: formatEpoch,
  });

  const revoke = (row: EncryptedDeviceRow) => {
    const copy = revokeEncryptedDeviceConfirm(row.title);
    showConfirmDialog({
      title: copy.title,
      message: copy.message,
      confirmText: copy.confirmText,
      destructive: true,
      onConfirm: () =>
        void hostedHubController.revokeE2eeDevice(row.device.enrollmentId, {
          expectedEnrollmentRevision: row.device.enrollmentRevision,
          reasonCode: "owner_requested",
        }),
    });
  };

  const actionsFor = (row: EncryptedDeviceRow): ReadonlyArray<AccessRowAction> =>
    row.active
      ? [
          {
            label: "Rename",
            disabled: !row.canChange,
            onPress: () => setRenameTarget(row.device),
          },
          {
            label: view.revoking ? "Revoking…" : "Revoke",
            destructive: true,
            disabled: !row.canChange,
            onPress: () => revoke(row),
          },
        ]
      : [];

  return (
    <>
      <AccessSection
        title="Encrypted devices"
        trailing={
          <ActionChip
            label="Refresh"
            disabled={view.refreshDisabled}
            onPress={() => void hostedHubController.refreshE2eeDevices({ force: true })}
          />
        }
        footnote={`${ACCOUNT_E2EE_TRUST_EXPLANATION} A new signed-in Desktop or mobile app enrolls its own keys; private keys stay on that device.`}
      >
        {view.empty !== null ? (
          <View className="gap-1 px-4 py-4">
            <Text className="text-base font-ryco-medium text-foreground">{view.empty.title}</Text>
            <Text className="font-sans text-sm leading-relaxed text-foreground-muted">
              {view.empty.detail}
            </Text>
          </View>
        ) : null}
        {view.rows.map((row, index) => (
          <AccessRow
            key={row.key}
            first={index === 0 && view.empty === null}
            title={row.title}
            detail={row.detail}
            status={{ ...(row.active ? LIVE_TONE : QUIET_TONE), label: row.statusLabel }}
            onPress={() => setExpanded(expanded === row.key ? null : row.key)}
            actions={actionsFor(row)}
          >
            {expanded === row.key ? (
              <View className="mx-4 mb-3 gap-2 border-t border-border-subtle pt-3">
                {row.facts.map((fact) => (
                  <View key={fact.label} className="gap-0.5">
                    <Text className="text-2xs font-ryco-bold uppercase tracking-wide text-foreground-muted">
                      {fact.label}
                    </Text>
                    <Text
                      selectable
                      className={`text-xs text-foreground ${fact.fingerprint === true ? "font-mono" : "font-sans"}`}
                    >
                      {fact.value}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
          </AccessRow>
        ))}
        {view.notice !== null ? <AccessQuietRow label={view.notice} /> : null}
      </AccessSection>

      {renameTarget !== null ? (
        <DeviceRenameSheet
          key={`${renameTarget.enrollmentId}:${String(renameTarget.enrollmentRevision)}`}
          label={renameTarget.deviceLabel}
          title={RENAME_ENCRYPTED_DEVICE_COPY.title}
          description={RENAME_ENCRYPTED_DEVICE_COPY.description}
          maxLength={NATIVE_E2EE_DEVICE_LABEL_MAX_CHARS}
          failureMessage="The Hub did not rename this device. Check your connection, then try again."
          onClose={() => setRenameTarget(null)}
          onSave={async (label) =>
            requireCommitted(
              await hostedHubController.renameE2eeDevice(renameTarget.enrollmentId, {
                expectedEnrollmentRevision: renameTarget.enrollmentRevision,
                deviceLabel: label,
              }),
            )
          }
        />
      ) : null}
    </>
  );
}
