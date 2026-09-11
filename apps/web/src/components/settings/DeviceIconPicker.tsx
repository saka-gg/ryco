import { useState } from "react";
import { ENVIRONMENT_MACHINE_KINDS, type EnvironmentMachineKind } from "@ryco/contracts";
import {
  ENVIRONMENT_MACHINE_LABELS,
  resolveEnvironmentMachineKind,
} from "@ryco/shared/environmentIcon";
import { updateEnvironmentServerSettings } from "../../environments/runtime";
import { useSettingsTarget } from "../../settingsTarget";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Select, SelectTrigger, SelectPopup, SelectItem } from "../ui/select";
import { SettingsRow } from "./settingsLayout";

export function DeviceIconPicker() {
  const target = useSettingsTarget();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!target) return null;
  const config = target.serverConfig;
  const supported = config?.environment.capabilities.environmentIcon === true;
  const allowed =
    target.connected && target.canManage !== false && target.canMutate !== false && supported;
  const kind = resolveEnvironmentMachineKind(config);
  const current = config?.settings.environmentIcon ?? "automatic";
  const save = async (value: EnvironmentMachineKind | "automatic" | null) => {
    if (!allowed || pending || value === null) return;
    setPending(true);
    setError(null);
    try {
      await updateEnvironmentServerSettings(target.environmentId, {
        environmentIcon: value === "automatic" ? null : value,
      });
    } catch {
      setError(`Could not save the icon for ${target.nodeLabel}. Reconnect and try again.`);
    } finally {
      setPending(false);
    }
  };
  return (
    <SettingsRow
      title="Device icon"
      scope={target.nodeLabel}
      description="Shown across mobile, desktop, and web. Automatic uses the device’s name and operating system."
      control={
        <Select<EnvironmentMachineKind | "automatic">
          value={current}
          disabled={!allowed || pending}
          onValueChange={save}
        >
          <SelectTrigger aria-label={`Device icon for ${target.nodeLabel}`} className="w-48">
            <EnvironmentMachineIcon kind={kind} className="size-4" />
            <span>
              {current === "automatic"
                ? `Automatic · ${ENVIRONMENT_MACHINE_LABELS[kind]}`
                : ENVIRONMENT_MACHINE_LABELS[kind]}
            </span>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="automatic">Automatic</SelectItem>
            {ENVIRONMENT_MACHINE_KINDS.map((value) => (
              <SelectItem key={value} value={value}>
                <span className="flex items-center gap-2">
                  <EnvironmentMachineIcon kind={value} className="size-4" />
                  {ENVIRONMENT_MACHINE_LABELS[value]}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
      status={
        error ? (
          <span role="alert">{error}</span>
        ) : !target.connected ? (
          <span>Connect to {target.nodeLabel} to change its icon.</span>
        ) : !supported ? (
          <span>Update this device to enable icon selection.</span>
        ) : !allowed ? (
          <span>Your access does not allow changing this device’s settings.</span>
        ) : undefined
      }
    />
  );
}
