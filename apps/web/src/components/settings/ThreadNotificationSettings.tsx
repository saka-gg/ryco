import {
  hasThreadSystemNotifications,
  THREAD_NOTIFICATION_MODE_OPTIONS,
  threadNotificationModeOf,
  threadNotificationModePatch,
  type ThreadNotificationMode,
} from "@ryco/client-runtime/state/settings";
import { DEFAULT_UNIFIED_SETTINGS } from "@ryco/contracts/settings";
import { useEffect, useState } from "react";

import { isElectron } from "../../env";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { SettingsSelect } from "./SettingsSelect";

const DEFAULT_MODE = threadNotificationModeOf(DEFAULT_UNIFIED_SETTINGS);

type BrowserNotificationPermission = NotificationPermission | "unsupported";

function readBrowserNotificationPermission(): BrowserNotificationPermission {
  return typeof Notification === "undefined" || !window.isSecureContext
    ? "unsupported"
    : Notification.permission;
}

/**
 * The browser's notification permission, read again when the user comes back
 * from its site settings. The desktop app shows its own notifications and
 * needs none.
 */
function useBrowserNotificationPermission() {
  const [permission, setPermission] = useState(readBrowserNotificationPermission);
  useEffect(() => {
    if (isElectron) return;
    const refresh = () => setPermission(readBrowserNotificationPermission());
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  // Browsers only prompt from a user gesture, so callers run this from one.
  const request = () => {
    if (isElectron || readBrowserNotificationPermission() !== "default") return;
    Notification.requestPermission().then(setPermission, () =>
      setPermission(readBrowserNotificationPermission()),
    );
  };
  return { permission: isElectron ? null : permission, request };
}

const PERMISSION_NOTICE: Partial<Record<BrowserNotificationPermission, string>> = {
  denied: "Notifications are blocked in this browser. Badges and sound still work.",
  unsupported: "This browser can't show notifications here. Badges and sound still work.",
};

/** How thread alerts reach this device: the alert mode and in-app toasts. */
export function ThreadNotificationSettings({ scope }: { scope?: string }) {
  const mode = useSettings(threadNotificationModeOf);
  const toasts = useSettings((settings) => settings.threadNotificationToasts);
  const { updateSettings } = useUpdateSettings();
  const { permission, request } = useBrowserNotificationPermission();
  const wantsNotifications = hasThreadSystemNotifications(mode);
  const permissionNotice =
    wantsNotifications && permission ? (PERMISSION_NOTICE[permission] ?? null) : null;

  const changeMode = (next: ThreadNotificationMode) => {
    updateSettings(threadNotificationModePatch(next));
    if (hasThreadSystemNotifications(next)) request();
  };

  return (
    <SettingsSection title="Notifications" owner="client">
      <SettingsRow
        title="Thread alerts"
        description="Get alerted when a thread on any connected machine finishes, fails, or needs you. Works while Ryco is open on this device."
        owner="client"
        {...(scope ? { scope } : {})}
        status={permissionNotice ?? undefined}
        resetAction={
          mode !== DEFAULT_MODE ? (
            <SettingResetButton
              label="thread alerts"
              onClick={() => updateSettings(threadNotificationModePatch(DEFAULT_MODE))}
            />
          ) : null
        }
        control={
          <>
            {wantsNotifications && permission === "default" ? (
              <Button type="button" size="xs" variant="outline" onClick={request}>
                Allow notifications
              </Button>
            ) : null}
            <SettingsSelect
              value={mode}
              onValueChange={changeMode}
              options={THREAD_NOTIFICATION_MODE_OPTIONS}
              ariaLabel="Thread alerts"
              width="lg"
            />
          </>
        }
      />
      <SettingsRow
        title="In-app alerts"
        description="Show a toast with Open thread when another thread finishes or needs you while Ryco is in front."
        owner="client"
        {...(scope ? { scope } : {})}
        resetAction={
          toasts !== DEFAULT_UNIFIED_SETTINGS.threadNotificationToasts ? (
            <SettingResetButton
              label="in-app alerts"
              onClick={() =>
                updateSettings({
                  threadNotificationToasts: DEFAULT_UNIFIED_SETTINGS.threadNotificationToasts,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={toasts}
            onCheckedChange={(checked) =>
              updateSettings({ threadNotificationToasts: Boolean(checked) })
            }
            aria-label="Show in-app alerts for other threads"
          />
        }
      />
    </SettingsSection>
  );
}
