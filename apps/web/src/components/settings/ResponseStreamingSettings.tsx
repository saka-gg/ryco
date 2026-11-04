import { DEFAULT_UNIFIED_SETTINGS, type ResponseStreamingMode } from "@ryco/contracts/settings";
import type { NodeSettingsConfig } from "@ryco/client-runtime/state/settings/nodeSettingsTargets";

import { useSettings } from "../../hooks/useSettings";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { useServerConfig } from "../../rpc/serverState";
import { SettingsSection } from "./settingsLayout";
import { SettingsSelect, type SettingsSelectOption } from "./SettingsSelect";
import { SharedSettingRow, sharedControlLabel } from "./sharedSettings/SharedSettingRow";

const MODE_OPTIONS: ReadonlyArray<SettingsSelectOption<ResponseStreamingMode>> = [
  { value: "paragraph", label: "Paragraphs" },
  { value: "turn", label: "Whole messages" },
  // The full label truncates in the standard-width trigger; the popup keeps "(legacy)".
  { value: "token", label: "Token by token (legacy)", triggerLabel: "Token by token" },
];

const MODE_DESCRIPTIONS: Record<ResponseStreamingMode, string> = {
  paragraph: "Each paragraph or code block appears once it is finished.",
  turn: "Each message appears once the agent has finished writing it.",
  token: "Text appears token by token. Slower, and long replies are harder to follow.",
};

const nodeKeepsStreamingModes = (config: NodeSettingsConfig): boolean =>
  config.environment.capabilities.responseStreamingModes === true;

// An older node reports no mode: it streams whole messages, or tokens if its legacy switch
// is on, and this client cannot read that switch.
const UNSUPPORTED_DESCRIPTION = "How assistant text appears while a reply streams.";
const UNSUPPORTED_STATUS =
  "This node does not support response streaming modes. Update the node to change this setting.";

/** Node setting for how assistant text reaches every client while a reply streams. */
export function ResponseStreamingSettings() {
  // Token by token asks first: it only exists for backwards compatibility.
  const selectMode = (
    next: ResponseStreamingMode,
    apply: (mode: ResponseStreamingMode) => void,
  ) => {
    if (next !== "token") {
      apply(next);
      return;
    }
    void (async () => {
      const confirmed = await (readLocalApi() ?? ensureLocalApi()).dialogs.confirm(
        [
          "Stream token by token?",
          "It is significantly slower than paragraph streaming and makes long replies harder to follow. This mode exists only for backwards compatibility.",
        ].join("\n"),
      );
      if (confirmed) apply("token");
    })();
  };

  return (
    <SettingsSection title="Responses" owner="node">
      <SharedSettingRow
        settingKey="responseStreamingMode"
        description={<ResponseStreamingDescription />}
        knowsSetting={nodeKeepsStreamingModes}
        unknownSettingStatus={UNSUPPORTED_STATUS}
        defaultValue={DEFAULT_UNIFIED_SETTINGS.responseStreamingMode}
        resetLabel="response streaming"
        render={(control) => (
          // An older node reports no mode: it streams its own way, so no mode is claimed.
          <SettingsSelect
            value={control.known ? control.value : ""}
            onValueChange={(next) => selectMode(next, control.onChange)}
            options={MODE_OPTIONS}
            ariaLabel={sharedControlLabel("Response streaming", control)}
            placeholder="Set by the node"
            disabled={control.disabled || !control.known}
          />
        )}
      />
    </SettingsSection>
  );
}

/** The shown device's mode, described; an older node streams its own way. */
function ResponseStreamingDescription() {
  const config = useServerConfig();
  const mode = useSettings((settings) => settings.responseStreamingMode);
  if (config !== null && config.environment.capabilities.responseStreamingModes !== true)
    return UNSUPPORTED_DESCRIPTION;
  return MODE_DESCRIPTIONS[mode];
}
