import { Pressable, ScrollView, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { TERMINAL_ACCESSORY_ROW, terminalAccessorySequence } from "./terminalInput";

function AccessoryButton(props: {
  readonly label: string;
  readonly name: string;
  readonly selected?: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.name}
      accessibilityState={{ selected: props.selected === true, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={`h-9 min-w-11 items-center justify-center rounded-lg border px-3 active:bg-white/15 ${
        props.selected ? "border-cyan-300 bg-cyan-300/20" : "border-white/10 bg-white/5"
      } ${props.disabled ? "opacity-30" : ""}`}
    >
      <Text className="font-mono text-sm font-ryco-bold text-white">{props.label}</Text>
    </Pressable>
  );
}

/**
 * The keys a phone keyboard lacks, arrows first. Ctrl is one-shot: it applies
 * to the next key and clears itself; tapping it again cancels it.
 */
export function TerminalAccessoryKeys(props: {
  readonly disabled: boolean;
  readonly controlArmed: boolean;
  readonly bottomInset: number;
  readonly onToggleControl: () => void;
  readonly onInput: (data: string) => void;
  readonly onDismissKeyboard: () => void;
}) {
  return (
    <View
      className="flex-row items-center border-t border-white/10 bg-[#111318] pt-2"
      style={{ paddingBottom: Math.max(8, props.bottomInset) }}
    >
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 7, paddingHorizontal: 10 }}
        className="min-w-0 flex-1"
      >
        {TERMINAL_ACCESSORY_ROW.map((item) =>
          item.kind === "control" ? (
            <AccessoryButton
              key="control"
              label={item.label}
              name={item.name}
              selected={props.controlArmed}
              disabled={props.disabled}
              onPress={props.onToggleControl}
            />
          ) : (
            <AccessoryButton
              key={item.key}
              label={item.label}
              name={item.name}
              disabled={props.disabled}
              onPress={() => props.onInput(terminalAccessorySequence(item.key))}
            />
          ),
        )}
      </ScrollView>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Hide keyboard"
        onPress={props.onDismissKeyboard}
        className="mr-2 h-9 w-11 items-center justify-center rounded-lg active:bg-white/15"
      >
        <SymbolView
          name={{ ios: "keyboard.chevron.compact.down", android: "keyboard_hide" }}
          size={18}
          tintColor="#d9dde5"
          type="monochrome"
        />
      </Pressable>
    </View>
  );
}
