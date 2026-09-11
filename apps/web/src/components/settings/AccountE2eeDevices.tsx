import { MonitorSmartphoneIcon } from "lucide-react";
import { useEffect, useState } from "react";

import type { HostedAccountE2eeDevice } from "@ryco/client-runtime/authorization";
import { NATIVE_E2EE_DEVICE_LABEL_MAX_CHARS } from "@ryco/contracts/native-e2ee";

import { hostedHubController, useHostedAccountStore } from "../../hostedHub/state";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input, TOUCH_INPUT_CLASS_NAME } from "../ui/input";
import { Label } from "../ui/label";
import { Spinner } from "../ui/spinner";
import {
  ACCOUNT_E2EE_TRUST_EXPLANATION,
  accountE2eeDeviceFacts,
  accountE2eeDevicePlatformLabel,
  accountE2eeDeviceStatusLabel,
  normalizeAccountE2eeDeviceLabel,
} from "./AccountE2eeDevices.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatEpoch(value: number): string {
  return timestampFormatter.format(new Date(value));
}

export function AccountE2eeDevices() {
  const devices = useHostedAccountStore((state) => state.e2eeDevices ?? []);
  const directoryStatus = useHostedAccountStore((state) => state.e2eeDevicesStatus ?? "idle");
  const actionStatus = useHostedAccountStore((state) => state.actionStatus);
  const [renameDevice, setRenameDevice] = useState<HostedAccountE2eeDevice | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [revokeDevice, setRevokeDevice] = useState<HostedAccountE2eeDevice | null>(null);

  const busy = actionStatus !== "idle";
  const renaming = actionStatus === "renaming-e2ee-device";
  const revoking = actionStatus === "revoking-e2ee-device";
  const normalizedRename = normalizeAccountE2eeDeviceLabel(renameDraft);

  useEffect(() => {
    void hostedHubController.refreshE2eeDevices();
  }, []);

  const submitRename = async () => {
    if (!renameDevice || normalizedRename === null) return;
    const outcome = await hostedHubController.renameE2eeDevice(renameDevice.enrollmentId, {
      expectedEnrollmentRevision: renameDevice.enrollmentRevision,
      deviceLabel: normalizedRename,
    });
    if (outcome.status === "committed") {
      setRenameDevice(null);
      setRenameDraft("");
    }
  };

  const submitRevoke = async () => {
    if (!revokeDevice) return;
    const outcome = await hostedHubController.revokeE2eeDevice(revokeDevice.enrollmentId, {
      expectedEnrollmentRevision: revokeDevice.enrollmentRevision,
      reasonCode: "owner_requested",
    });
    if (outcome.status === "committed") setRevokeDevice(null);
  };

  return (
    <SettingsSection
      title="Encrypted devices"
      icon={<MonitorSmartphoneIcon aria-hidden className="size-3.5" />}
      headerAction={
        <Button
          size="xs"
          variant="ghost"
          disabled={busy || directoryStatus === "loading"}
          onClick={() => void hostedHubController.refreshE2eeDevices({ force: true })}
        >
          Refresh
        </Button>
      }
    >
      <SettingsRow
        title="Automatic native encryption"
        description={ACCOUNT_E2EE_TRUST_EXPLANATION}
        status="A new signed-in Desktop or mobile app enrolls its own keys; private keys stay on that device."
      />

      {devices.length === 0 ? (
        <SettingsRow
          title={directoryStatus === "loading" ? "Loading devices…" : "No native devices yet"}
          description="Sign in from Ryco Desktop or mobile to enroll that app automatically. Web sessions stay separate and do not join this native device trust set."
          status={
            directoryStatus === "stale" ? "The device directory is temporarily unavailable." : null
          }
          control={directoryStatus === "loading" ? <Spinner className="size-3.5" /> : null}
        />
      ) : (
        devices.map((device) => {
          const active = device.status === "active";
          return (
            <SettingsRow
              key={`${device.enrollmentId}:${String(device.enrollmentRevision)}`}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {device.deviceLabel}
                  <Badge variant={active ? "success" : "secondary"}>
                    {accountE2eeDeviceStatusLabel(device)}
                  </Badge>
                </span>
              }
              description={`${accountE2eeDevicePlatformLabel(device)} · Ryco ${device.appVersion}`}
              status={
                directoryStatus === "stale" ? "Showing the last device directory Ryco read." : null
              }
              control={
                active ? (
                  <>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        setRenameDevice(device);
                        setRenameDraft(device.deviceLabel);
                      }}
                    >
                      Rename
                    </Button>
                    <Button
                      size="xs"
                      variant="destructive-outline"
                      disabled={busy}
                      onClick={() => setRevokeDevice(device)}
                    >
                      Revoke
                    </Button>
                  </>
                ) : null
              }
            >
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 border-t border-border/60 py-3">
                {accountE2eeDeviceFacts(device, formatEpoch).map((fact) => (
                  <div key={fact.label} className="contents">
                    <dt className="text-xs text-muted-foreground">{fact.label}</dt>
                    <dd
                      className={
                        fact.fingerprint
                          ? "min-w-0 font-mono text-xs break-all"
                          : "min-w-0 text-xs break-all"
                      }
                    >
                      {fact.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </SettingsRow>
          );
        })
      )}

      <Dialog
        open={renameDevice !== null}
        onOpenChange={(open) => {
          if (open || renaming) return;
          setRenameDevice(null);
          setRenameDraft("");
        }}
      >
        <DialogPopup className="max-w-sm">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitRename();
            }}
          >
            <DialogHeader>
              <DialogTitle>Rename encrypted device</DialogTitle>
              <DialogDescription>
                This label is account metadata. Renaming does not rotate or replace the device keys.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-2">
              <Label htmlFor="account-e2ee-device-label">Device name</Label>
              <Input
                id="account-e2ee-device-label"
                value={renameDraft}
                maxLength={NATIVE_E2EE_DEVICE_LABEL_MAX_CHARS}
                disabled={renaming}
                className={TOUCH_INPUT_CLASS_NAME}
                onChange={(event) => setRenameDraft(event.target.value)}
              />
            </DialogPanel>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={renaming}
                onClick={() => {
                  setRenameDevice(null);
                  setRenameDraft("");
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={renaming || normalizedRename === null}>
                {renaming ? <Spinner className="size-3.5" /> : null}
                Save name
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>

      <AlertDialog
        open={revokeDevice !== null}
        onOpenChange={(open) => {
          if (!open && !revoking) setRevokeDevice(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this encrypted device?</AlertDialogTitle>
            <AlertDialogDescription>
              {revokeDevice?.deviceLabel ?? "The selected device"} will lose account-authorized
              native connections. Signing in again can enroll fresh keys, but this enrollment cannot
              be restored.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={revoking} />}>
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={revoking} onClick={() => void submitRevoke()}>
              {revoking ? <Spinner className="size-3.5" /> : null}
              Revoke device
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}
