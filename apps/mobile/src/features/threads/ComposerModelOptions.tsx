import { Pressable, Switch, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import type { ModelOptionControl } from "./modelPickerModel";

export function ComposerModelOptions(props: {
  readonly modelLabel: string;
  readonly options: ReadonlyArray<ModelOptionControl>;
  readonly disabled: boolean;
  readonly onSelect: (id: string, value: string | boolean) => void;
}) {
  const warning = useThemeColor("--color-warning");
  if (props.options.length === 0) return null;
  return (
    <View className="gap-2 border-t border-border px-3 py-2">
      <Text className="text-xs font-ryco-medium text-foreground-muted" numberOfLines={1}>
        {props.modelLabel}
      </Text>
      {props.options.map((option) =>
        option.kind === "select" ? (
          <View
            key={option.id}
            className="gap-1.5"
            accessibilityRole="radiogroup"
            accessibilityLabel={option.label}
          >
            <Text className="text-xs text-foreground-muted">{option.label}</Text>
            <View className="flex-row flex-wrap gap-1">
              {option.choices.map((choice) => (
                <Pressable
                  key={choice.id}
                  accessibilityRole="radio"
                  accessibilityLabel={`${option.label}: ${choice.label}`}
                  accessibilityState={{ checked: choice.selected, disabled: props.disabled }}
                  disabled={props.disabled}
                  onPress={() => props.onSelect(option.id, choice.id)}
                  className={`min-h-11 min-w-11 flex-1 items-center justify-center rounded-xl px-1 active:opacity-70 disabled:opacity-40 ${choice.selected ? "bg-primary" : "bg-subtle"}`}
                >
                  <Text
                    numberOfLines={1}
                    className={`text-xs font-ryco-medium ${choice.selected ? "text-primary-foreground" : "text-foreground"}`}
                  >
                    {choice.shortLabel}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : (
          <View key={option.id} className="min-h-11 flex-row items-center gap-2">
            <SymbolView name="bolt.fill" size={15} tintColor={warning} type="monochrome" />
            <Text className="flex-1 text-sm text-foreground">{option.label}</Text>
            <Switch
              accessibilityLabel={option.label}
              disabled={props.disabled}
              value={option.enabled}
              onValueChange={(value) => props.onSelect(option.id, value)}
              trackColor={{ true: warning as string }}
            />
          </View>
        ),
      )}
    </View>
  );
}
