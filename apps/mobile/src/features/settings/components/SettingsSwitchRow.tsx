import { Switch, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";

export function SettingsSwitchRow(props: {
  readonly label: string;
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
  readonly detail?: string;
  readonly first?: boolean;
}) {
  return (
    <View
      className={`flex-row items-center gap-3 px-5 py-3 ${props.first ? "" : "border-t border-border-subtle"}`}
    >
      <View className="min-w-0 flex-1">
        <Text className="font-sans text-[17px] text-foreground">{props.label}</Text>
        {props.detail ? (
          <Text className="mt-0.5 font-sans text-xs leading-4 text-foreground-muted">
            {props.detail}
          </Text>
        ) : null}
      </View>
      <Switch value={props.value} onValueChange={props.onValueChange} />
    </View>
  );
}
