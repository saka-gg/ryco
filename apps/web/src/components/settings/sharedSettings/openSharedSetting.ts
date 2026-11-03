import type { ShareableServerSettingKey } from "@ryco/shared/settingsSharing";

import { useSettingsDialogStore } from "../../../settingsDialogStore";
import { requestSettingsReveal } from "../settingsSearchReveal";
import { SHARED_SETTING_DISPLAY, sharedSettingRowId } from "./sharedSettingsCatalog";
import { requestSharedRowOpen, setSettingsDeviceView } from "./sharedSettingsMode";

/**
 * Opens a shared setting where it lives: its section, every device shown, the row revealed
 * with its device list open. The compare table and "Where this device differs" use it.
 */
export function openSharedSetting(key: ShareableServerSettingKey): void {
  setSettingsDeviceView("all");
  requestSharedRowOpen(key);
  requestSettingsReveal(sharedSettingRowId(key));
  useSettingsDialogStore.getState().setSection(SHARED_SETTING_DISPLAY[key].section);
}
