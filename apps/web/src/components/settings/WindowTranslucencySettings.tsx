import {
  DESKTOP_WINDOW_BLUR_RADIUS_MAX,
  DESKTOP_WINDOW_BLUR_RADIUS_MIN,
} from "@ryco/contracts/window-material";
import { useEffect, useState } from "react";

import {
  APPEARANCE_PREFERENCES_CHANGE_EVENT,
  WINDOW_TRANSLUCENCY_OPACITY_MAX,
  WINDOW_TRANSLUCENCY_OPACITY_MIN,
  hasAppearancePreferenceOverride,
  isSurfaceTransparencyReducedBySystem,
  type AppearancePreferenceKey,
  type AppearancePreferences,
} from "../../themes/appearancePreferences";
import {
  WINDOW_MATERIAL_CHANGE_EVENT,
  isDesktopBlurUnavailable,
} from "../../themes/windowTranslucency";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

/**
 * The translucent window controls (macOS desktop): on/off, sidebar-only, the
 * glass coat's opacity and the desktop blur radius. Rendered inside the
 * Appearance → Interface section only where the host supports it.
 */
export function WindowTranslucencySettings({
  preferences,
  onChange,
  onReset,
}: {
  readonly preferences: AppearancePreferences;
  readonly onChange: (key: AppearancePreferenceKey, value: string) => void;
  readonly onReset: (key: AppearancePreferenceKey) => void;
}) {
  const [reducedBySystem, setReducedBySystem] = useState(isSurfaceTransparencyReducedBySystem);
  const [blurUnavailable, setBlurUnavailable] = useState(isDesktopBlurUnavailable);
  useEffect(() => {
    const syncReduced = () => setReducedBySystem(isSurfaceTransparencyReducedBySystem());
    const syncBlur = () => setBlurUnavailable(isDesktopBlurUnavailable());
    window.addEventListener(APPEARANCE_PREFERENCES_CHANGE_EVENT, syncReduced);
    window.addEventListener(WINDOW_MATERIAL_CHANGE_EVENT, syncBlur);
    return () => {
      window.removeEventListener(APPEARANCE_PREFERENCES_CHANGE_EVENT, syncReduced);
      window.removeEventListener(WINDOW_MATERIAL_CHANGE_EVENT, syncBlur);
    };
  }, []);

  const scope = preferences.windowTranslucency;
  const enabled = scope === "window" || scope === "sidebar";
  const resetFor = (key: AppearancePreferenceKey, label: string) =>
    hasAppearancePreferenceOverride(key) ? (
      <SettingResetButton label={label} onClick={() => onReset(key)} />
    ) : null;

  return (
    <>
      <SettingsRow
        title="Translucent window"
        description={
          reducedBySystem
            ? "Paused while Reduce transparency is on in macOS Accessibility settings."
            : "Let the desktop show through the app window, blurred."
        }
        resetAction={resetFor("windowTranslucency", "translucent window")}
        control={
          <Switch
            checked={enabled}
            onCheckedChange={(checked) =>
              onChange("windowTranslucency", checked ? "window" : "off")
            }
            aria-label="Translucent window"
          />
        }
      />
      {enabled ? (
        <>
          <SettingsRow
            title="Sidebar only"
            description="Keep the content opaque and let the desktop through the sidebar alone."
            control={
              <Switch
                checked={scope === "sidebar"}
                onCheckedChange={(checked) =>
                  onChange("windowTranslucency", checked ? "sidebar" : "window")
                }
                aria-label="Translucent sidebar only"
              />
            }
          />
          <WindowGlassRangeRow
            title="Glass opacity"
            description="How much of the window's own color covers the desktop."
            ariaLabel="Translucent window opacity"
            min={WINDOW_TRANSLUCENCY_OPACITY_MIN}
            max={WINDOW_TRANSLUCENCY_OPACITY_MAX}
            suffix="%"
            value={Number(preferences.windowTranslucencyOpacity)}
            onChange={(value) => onChange("windowTranslucencyOpacity", String(value))}
            resetAction={resetFor("windowTranslucencyOpacity", "glass opacity")}
          />
          <WindowGlassRangeRow
            title="Desktop blur"
            description={
              blurUnavailable
                ? "macOS refused a custom blur here, so the window uses the system material."
                : "How strongly the desktop behind the window is blurred."
            }
            ariaLabel="Translucent window blur"
            min={DESKTOP_WINDOW_BLUR_RADIUS_MIN}
            max={DESKTOP_WINDOW_BLUR_RADIUS_MAX}
            suffix=" pt"
            value={Number(preferences.windowTranslucencyBlur)}
            onChange={(value) => onChange("windowTranslucencyBlur", String(value))}
            resetAction={resetFor("windowTranslucencyBlur", "desktop blur")}
          />
        </>
      ) : null}
    </>
  );
}

function WindowGlassRangeRow({
  title,
  description,
  ariaLabel,
  min,
  max,
  suffix,
  value,
  onChange,
  resetAction,
}: {
  readonly title: string;
  readonly description: string;
  readonly ariaLabel: string;
  readonly min: number;
  readonly max: number;
  readonly suffix: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly resetAction: React.ReactNode;
}) {
  return (
    <SettingsRow
      title={title}
      description={description}
      resetAction={resetAction}
      control={
        <span className="min-w-12 text-right text-xs font-medium tabular-nums text-foreground">
          {value}
          {suffix}
        </span>
      }
    >
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        aria-label={ariaLabel}
        className="settings-range h-7.5 w-full cursor-pointer"
      />
    </SettingsRow>
  );
}
