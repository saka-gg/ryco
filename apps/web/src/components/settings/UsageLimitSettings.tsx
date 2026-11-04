import type { NodeSettingsConfig } from "@ryco/client-runtime/state/settings/nodeSettingsTargets";
import { DEFAULT_UNIFIED_SETTINGS } from "@ryco/contracts/settings";

import { Switch } from "../ui/switch";
import { SettingsSection } from "./settingsLayout";
import { SharedSettingRow, sharedControlLabel } from "./sharedSettings/SharedSettingRow";

const UNSUPPORTED_STATUS =
  "This node does not support usage-limit recovery. Update the node to change this setting.";

// An older node would silently drop the keys: its controls stay disabled.
const nodeRunsLimitRecovery = (config: NodeSettingsConfig): boolean =>
  config.environment.capabilities.usageLimitRecovery === true;

/** Node settings for threads stopped by a provider usage limit, shared across devices. */
export function UsageLimitSettings() {
  return (
    <SettingsSection title="Usage limits" owner="node">
      <SharedSettingRow
        settingKey="autoResumeLimitedThreads"
        description="When a provider usage limit stops a thread, send 'Continue where you left off.' at the reported reset time. Limits apply to the whole provider account, and every resumed thread re-reads its conversation (on long Claude threads this rebuilds the prompt cache at full input cost). Each thread can cancel its scheduled resume."
        knowsSetting={nodeRunsLimitRecovery}
        unknownSettingStatus={UNSUPPORTED_STATUS}
        defaultValue={DEFAULT_UNIFIED_SETTINGS.autoResumeLimitedThreads}
        resetLabel="auto-resume limited threads"
        render={(control) => (
          <Switch
            checked={control.value}
            disabled={control.disabled}
            onCheckedChange={(checked) => control.onChange(Boolean(checked))}
            aria-label={sharedControlLabel("Auto-resume limited threads", control)}
          />
        )}
      />
      <SharedSettingRow
        settingKey="snoozeLimitedThreads"
        description="Snooze usage-limit stops until the reported reset time. Combine with auto-resume to continue when they wake."
        knowsSetting={nodeRunsLimitRecovery}
        unknownSettingStatus={UNSUPPORTED_STATUS}
        defaultValue={DEFAULT_UNIFIED_SETTINGS.snoozeLimitedThreads}
        resetLabel="snooze limited threads"
        render={(control) => (
          <Switch
            checked={control.value}
            disabled={control.disabled}
            onCheckedChange={(checked) => control.onChange(Boolean(checked))}
            aria-label={sharedControlLabel("Snooze limited threads", control)}
          />
        )}
      />
    </SettingsSection>
  );
}
