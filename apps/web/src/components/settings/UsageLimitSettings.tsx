import { DEFAULT_UNIFIED_SETTINGS } from "@ryco/contracts/settings";

import { useAppPreferencesLabel } from "../../deviceName";
import { isElectron } from "../../env";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useServerConfig } from "../../rpc/serverState";
import { useSettingsEditingScope, useSettingsTarget } from "../../settingsTarget";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { settingsScopeLabel } from "./settingsSections.logic";

const UNSUPPORTED_STATUS =
  "This node does not support usage-limit recovery. Update the node to change this setting.";

/**
 * Node settings for threads stopped by a provider usage limit. Disabled unless the node
 * runs the recovery worker: an older node would silently drop the keys.
 */
export function UsageLimitSettings() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const config = useServerConfig();
  const target = useSettingsTarget();
  const scope = useSettingsEditingScope();
  const appLabel = useAppPreferencesLabel();
  const nodeScopeLabel = settingsScopeLabel("node", {
    appLabel,
    nativeClient: isElectron,
    nodeLabel: target?.nodeLabel ?? null,
  });
  const supported = config?.environment.capabilities.usageLimitRecovery === true;
  const disabled =
    !supported ||
    scope === "client" ||
    (scope === "node" && !target) ||
    Boolean(
      target && (!target.connected || target.canManage === false || target.canMutate === false),
    );
  const status = supported ? undefined : UNSUPPORTED_STATUS;

  return (
    <SettingsSection title="Usage limits" owner="node">
      <SettingsRow
        title="Auto-resume limited threads"
        description="When a provider usage limit stops a thread, send 'Continue where you left off.' at the reported reset time. Limits apply to the whole provider account, and every resumed thread re-reads its conversation (on long Claude threads this rebuilds the prompt cache at full input cost). Each thread can cancel its scheduled resume."
        owner="node"
        scope={nodeScopeLabel}
        status={status}
        resetAction={
          !disabled &&
          settings.autoResumeLimitedThreads !==
            DEFAULT_UNIFIED_SETTINGS.autoResumeLimitedThreads ? (
            <SettingResetButton
              label="auto-resume limited threads"
              onClick={() =>
                updateSettings({
                  autoResumeLimitedThreads: DEFAULT_UNIFIED_SETTINGS.autoResumeLimitedThreads,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.autoResumeLimitedThreads}
            disabled={disabled}
            onCheckedChange={(checked) =>
              updateSettings({ autoResumeLimitedThreads: Boolean(checked) })
            }
            aria-label="Auto-resume limited threads"
          />
        }
      />
      <SettingsRow
        title="Snooze limited threads"
        description="Snooze usage-limit stops until the reported reset time. Combine with auto-resume to continue when they wake."
        owner="node"
        scope={nodeScopeLabel}
        status={status}
        resetAction={
          !disabled &&
          settings.snoozeLimitedThreads !== DEFAULT_UNIFIED_SETTINGS.snoozeLimitedThreads ? (
            <SettingResetButton
              label="snooze limited threads"
              onClick={() =>
                updateSettings({
                  snoozeLimitedThreads: DEFAULT_UNIFIED_SETTINGS.snoozeLimitedThreads,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.snoozeLimitedThreads}
            disabled={disabled}
            onCheckedChange={(checked) =>
              updateSettings({ snoozeLimitedThreads: Boolean(checked) })
            }
            aria-label="Snooze limited threads"
          />
        }
      />
    </SettingsSection>
  );
}
