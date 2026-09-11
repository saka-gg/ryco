import { useAppPreferencesLabel } from "../../deviceName";
import { useEffect, useState } from "react";
import type { DesktopQuitShortcutMode } from "@ryco/contracts";
import { SettingsRow } from "./settingsLayout";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const labels = {
  "press-twice": "Press twice",
  hold: "Hold for 1 second",
  immediately: "Immediately",
} as const;

export function QuitShortcutSetting() {
  const appLabel = useAppPreferencesLabel();
  const api = window.desktopBridge?.quitShortcut;
  const [mode, setMode] = useState<DesktopQuitShortcutMode | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api
      ?.getMode()
      .then((value) => {
        if (live) setMode(value);
      })
      .catch(() => {
        if (live) setError("Could not load quit shortcut preference.");
      });
    return () => {
      live = false;
    };
  }, [api]);
  if (!api) return null;
  return (
    <SettingsRow
      title="Quit shortcut"
      scope={appLabel}
      description="Prevent accidental quits with a second press within 1.5 seconds, or hold for 1 second and release."
      status={error ? <span role="alert">{error}</span> : undefined}
      control={
        <Select
          value={mode}
          disabled={mode === null || saving}
          onValueChange={(value) => {
            if (value !== "press-twice" && value !== "hold" && value !== "immediately") return;
            setSaving(true);
            setError(null);
            void api
              .setMode(value)
              .then(() => setMode(value))
              .catch(() => setError("Could not save quit shortcut preference."))
              .finally(() => setSaving(false));
          }}
        >
          <SelectTrigger aria-label="Quit shortcut" className="w-full sm:w-44">
            <SelectValue>{mode ? labels[mode] : "Loading…"}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {Object.entries(labels).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
