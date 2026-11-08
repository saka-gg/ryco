import type { ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/AppText";

/** A grouped card of settings rows with a quiet header above and an optional note below. */
export function SettingsSection(props: {
  readonly title?: string;
  readonly footer?: string;
  readonly children: ReactNode;
}) {
  return (
    <View className="mt-6 gap-2 px-4">
      {props.title ? (
        <Text className="px-2 text-[13px] font-ryco-medium text-foreground-muted">
          {props.title}
        </Text>
      ) : null}
      <View className="overflow-hidden rounded-[22px] bg-card">{props.children}</View>
      {props.footer ? (
        <Text className="px-2 text-xs leading-4 text-foreground-muted">{props.footer}</Text>
      ) : null}
    </View>
  );
}
