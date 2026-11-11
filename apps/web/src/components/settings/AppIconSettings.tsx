import { useEffect, useState } from "react";
import {
  APP_ICON_MARK_PATH,
  APP_ICON_PREVIEW_TILE,
  APP_ICON_VARIANT_SPECS,
  APP_ICON_VARIANTS,
  type AppIconVariant,
} from "@ryco/shared/appIcon";

import { cn, isMacPlatform, isWindowsPlatform } from "../../lib/utils";
import {
  APPEARANCE_TILE_CLASS,
  APPEARANCE_TILE_IDLE_CLASS,
  APPEARANCE_TILE_SELECTED_CLASS,
} from "./appearanceTiles";
import { SettingsSection } from "./settingsLayout";

const TILE = APP_ICON_PREVIEW_TILE;

/** A variant drawn from its colors, so the picker ships no pictures. */
export function AppIconPreview({
  variant,
  className,
}: {
  readonly variant: AppIconVariant;
  readonly className?: string;
}) {
  const spec = APP_ICON_VARIANT_SPECS[variant];
  return (
    <svg
      viewBox={`${TILE.x} ${TILE.y} ${TILE.size} ${TILE.size}`}
      className={cn("text-foreground", className)}
      aria-hidden
    >
      <rect
        x={TILE.x}
        y={TILE.y}
        width={TILE.size}
        height={TILE.size}
        rx={TILE.radius}
        fill={spec.tile}
      />
      <path d={APP_ICON_MARK_PATH} fill={spec.mark} />
      {/* A hairline, so the tile that matches the card still reads as a tile. */}
      <rect
        x={TILE.x + 4}
        y={TILE.y + 4}
        width={TILE.size - 8}
        height={TILE.size - 8}
        rx={TILE.radius - 4}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.12}
        strokeWidth={8}
      />
    </svg>
  );
}

function appIconDescription(platform: string): string {
  if (isMacPlatform(platform)) return "Shown in the Dock while Ryco runs.";
  if (isWindowsPlatform(platform)) return "Shown on the taskbar and in window title bars.";
  return "Shown in window title bars and, where your desktop draws it, the taskbar.";
}

/** Settings → Appearance → App icon; desktop only (`desktopBridge.appIcon`). */
export function AppIconSettings() {
  const api = window.desktopBridge?.appIcon;
  const [variant, setVariant] = useState<AppIconVariant | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api
      ?.getVariant()
      .then((value) => {
        if (live) setVariant(value);
      })
      .catch(() => {
        if (live) setError("Could not load the app icon.");
      });
    return () => {
      live = false;
    };
  }, [api]);
  if (!api) return null;

  const choose = (next: AppIconVariant) => {
    if (next === variant) return;
    const previous = variant;
    setVariant(next);
    setError(null);
    void api.setVariant(next).catch(() => {
      setVariant(previous);
      setError("Could not change the app icon.");
    });
  };

  return (
    <SettingsSection
      title="App icon"
      description={
        error ? (
          <span role="alert" className="text-destructive">
            {error}
          </span>
        ) : (
          appIconDescription(navigator.platform)
        )
      }
      bare
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" role="group" aria-label="App icon">
        {APP_ICON_VARIANTS.map((option) => {
          const spec = APP_ICON_VARIANT_SPECS[option];
          const selected = variant === option;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={selected}
              disabled={variant === null}
              onClick={() => choose(option)}
              className={cn(
                APPEARANCE_TILE_CLASS,
                "flex flex-col items-center gap-2 px-2 pt-4 pb-3 text-center disabled:opacity-60",
                selected ? APPEARANCE_TILE_SELECTED_CLASS : APPEARANCE_TILE_IDLE_CLASS,
              )}
            >
              <AppIconPreview variant={option} className="size-14 drop-shadow-sm" />
              <span className="flex flex-col gap-0.5">
                <span className="text-[13px] font-medium text-foreground">{spec.label}</span>
                <span className="text-[11px] text-muted-foreground">{spec.description}</span>
              </span>
            </button>
          );
        })}
      </div>
    </SettingsSection>
  );
}
