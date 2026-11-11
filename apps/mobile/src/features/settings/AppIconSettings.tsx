import * as Haptics from "expo-haptics";
import { useEffect, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import {
  APP_ICON_MARK_PATH,
  APP_ICON_PREVIEW_TILE,
  APP_ICON_VARIANT_SPECS,
  APP_ICON_VARIANTS,
  appIconVariantFromIosName,
  iosAlternateAppIconName,
  type AppIconVariant,
} from "@ryco/shared/appIcon";

import { AppText as Text } from "../../components/AppText";
import { rycoAppRuntimeNative } from "../../platform/appRuntimeNative";
import { SettingsSection } from "./components/SettingsSection";

const TILE = APP_ICON_PREVIEW_TILE;

function AppIconPreview(props: { readonly variant: AppIconVariant; readonly size: number }) {
  const spec = APP_ICON_VARIANT_SPECS[props.variant];
  return (
    <Svg
      width={props.size}
      height={props.size}
      viewBox={`${TILE.x} ${TILE.y} ${TILE.size} ${TILE.size}`}
    >
      <Rect
        x={TILE.x}
        y={TILE.y}
        width={TILE.size}
        height={TILE.size}
        rx={TILE.radius}
        fill={spec.tile}
      />
      <Path d={APP_ICON_MARK_PATH} fill={spec.mark} />
      {/* A hairline, so the tile that matches the card still reads as a tile. */}
      <Rect
        x={TILE.x + 4}
        y={TILE.y + 4}
        width={TILE.size - 8}
        height={TILE.size - 8}
        rx={TILE.radius - 4}
        fill="none"
        stroke="#808080"
        strokeOpacity={0.25}
        strokeWidth={8}
      />
    </Svg>
  );
}

/** The app icon switch, where this binary has it: iOS with alternate icon sets. */
function appIconNative() {
  const native = rycoAppRuntimeNative();
  if (Platform.OS !== "ios" || !native?.getAppIconName || !native.setAppIconName) return null;
  return { get: native.getAppIconName, set: native.setAppIconName };
}

/** Settings → Appearance → App icon: the Home Screen icon. */
export function AppIconSettings() {
  const [native] = useState(appIconNative);
  const [variant, setVariant] = useState<AppIconVariant | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!native) return;
    let live = true;
    native
      .get()
      .then((name) => {
        if (live) setVariant(appIconVariantFromIosName(name));
      })
      .catch(() => {
        if (live) setError("Could not read the app icon.");
      });
    return () => {
      live = false;
    };
  }, [native]);
  if (!native) return null;

  const choose = (next: AppIconVariant) => {
    if (variant === null || next === variant) return;
    void Haptics.selectionAsync().catch(() => undefined);
    const previous = variant;
    setVariant(next);
    setError(null);
    native.set(iosAlternateAppIconName(next)).catch(() => {
      setVariant(previous);
      setError("Could not change the app icon.");
    });
  };

  return (
    <SettingsSection
      title="App icon"
      footer={error ?? "The icon on your Home Screen. iOS confirms the change."}
    >
      <View className="flex-row justify-between px-3 py-4" accessibilityRole="radiogroup">
        {APP_ICON_VARIANTS.map((option) => {
          const spec = APP_ICON_VARIANT_SPECS[option];
          const selected = variant === option;
          return (
            <Pressable
              key={option}
              onPress={() => choose(option)}
              disabled={variant === null}
              accessibilityRole="radio"
              accessibilityLabel={`${spec.label}: ${spec.description}`}
              accessibilityState={{ selected, disabled: variant === null }}
              className="flex-1 items-center gap-2 active:opacity-70"
            >
              <View
                className={`rounded-[18px] border-2 p-0.5 ${selected ? "border-accent" : "border-transparent"}`}
              >
                <AppIconPreview variant={option} size={56} />
              </View>
              <Text
                className={`font-sans text-xs ${selected ? "font-ryco-medium text-foreground" : "text-foreground-muted"}`}
              >
                {spec.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </SettingsSection>
  );
}
