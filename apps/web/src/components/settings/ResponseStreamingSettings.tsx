import { DEFAULT_UNIFIED_SETTINGS, type ResponseStreamingMode } from "@ryco/contracts/settings";

import { useAppPreferencesLabel } from "../../deviceName";
import { isElectron } from "../../env";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { useServerConfig } from "../../rpc/serverState";
import { useSettingsTarget } from "../../settingsTarget";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { settingsScopeLabel } from "./settingsSections.logic";
import { SettingsSelect, type SettingsSelectOption } from "./SettingsSelect";

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

// An older node reports no mode: it streams whole messages, or tokens if its legacy switch
// is on, and this client cannot read that switch.
const UNSUPPORTED_DESCRIPTION = "How assistant text appears while a reply streams.";
const UNSUPPORTED_STATUS =
  "This node does not support response streaming modes. Update the node to change this setting.";

/** Node setting for how assistant text reaches every client while a reply streams. */
export function ResponseStreamingSettings() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const config = useServerConfig();
  const supported = config?.environment.capabilities.responseStreamingModes === true;
  const unsupported = config !== null && !supported;
  const target = useSettingsTarget();
  const appLabel = useAppPreferencesLabel();
  const nodeScopeLabel = settingsScopeLabel("node", {
    appLabel,
    nativeClient: isElectron,
    nodeLabel: target?.nodeLabel ?? null,
  });
  const mode = settings.responseStreamingMode;

  const selectMode = (next: ResponseStreamingMode) => {
    if (next !== "token") {
      updateSettings({ responseStreamingMode: next });
      return;
    }
    void (async () => {
      const confirmed = await (readLocalApi() ?? ensureLocalApi()).dialogs.confirm(
        [
          "Stream token by token?",
          "It is significantly slower than paragraph streaming and makes long replies harder to follow. This mode exists only for backwards compatibility.",
        ].join("\n"),
      );
      if (confirmed) updateSettings({ responseStreamingMode: "token" });
    })();
  };

  return (
    <SettingsSection title="Responses" owner="node">
      <SettingsRow
        id="response-streaming"
        title="Response streaming"
        description={unsupported ? UNSUPPORTED_DESCRIPTION : MODE_DESCRIPTIONS[mode]}
        owner="node"
        scope={nodeScopeLabel}
        status={unsupported ? UNSUPPORTED_STATUS : undefined}
        resetAction={
          supported && mode !== DEFAULT_UNIFIED_SETTINGS.responseStreamingMode ? (
            <SettingResetButton
              label="response streaming"
              onClick={() =>
                updateSettings({
                  responseStreamingMode: DEFAULT_UNIFIED_SETTINGS.responseStreamingMode,
                })
              }
            />
          ) : null
        }
        control={
          <SettingsSelect
            value={unsupported ? "" : mode}
            onValueChange={selectMode}
            options={MODE_OPTIONS}
            ariaLabel="Response streaming"
            placeholder="Set by the node"
            disabled={!supported}
          />
        }
      />
    </SettingsSection>
  );
}
