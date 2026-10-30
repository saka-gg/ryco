import { useState, useSyncExternalStore } from "react";
import { Modal, Pressable, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  canStepCustomSnoozeDayBack,
  customSnoozeDayLabel,
  type CustomSnoozeDraft,
  type CustomSnoozeUnit,
  finishCustomSnooze,
  initialCustomSnoozeDraft,
  isCustomSnoozeRequested,
  resolveCustomSnoozeDraft,
  stepCustomSnoozeDay,
  stepCustomSnoozeTime,
  subscribeCustomSnooze,
} from "./customSnoozeModel";

const MODES = [
  { value: "date", label: "Date and time" },
  { value: "duration", label: "Duration" },
] as const;

const UNITS: ReadonlyArray<{ readonly value: CustomSnoozeUnit; readonly label: string }> = [
  { value: "minutes", label: "Minutes" },
  { value: "hours", label: "Hours" },
  { value: "days", label: "Days" },
];

function Choice(props: {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected }}
      onPress={props.onPress}
      className={`min-h-11 flex-1 items-center justify-center rounded-xl ${
        props.selected ? "bg-subtle-strong" : "bg-subtle"
      }`}
    >
      <Text className="text-sm font-ryco-medium text-foreground">{props.label}</Text>
    </Pressable>
  );
}

function Stepper(props: {
  readonly label: string;
  readonly value: string;
  readonly canStepBack: boolean;
  readonly onStep: (direction: 1 | -1) => void;
}) {
  return (
    <View className="min-h-12 flex-row items-center gap-2 rounded-xl bg-subtle px-2">
      <Text className="w-12 pl-1 text-sm text-foreground-muted">{props.label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Earlier ${props.label.toLowerCase()}`}
        disabled={!props.canStepBack}
        onPress={() => props.onStep(-1)}
        className="h-11 w-11 items-center justify-center disabled:opacity-30"
      >
        <SymbolView name="chevron.left" size={15} type="monochrome" />
      </Pressable>
      <Text
        accessibilityLiveRegion="polite"
        className="flex-1 text-center text-base font-ryco-medium text-foreground"
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {props.value}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Later ${props.label.toLowerCase()}`}
        onPress={() => props.onStep(1)}
        className="h-11 w-11 items-center justify-center"
      >
        <SymbolView name="chevron.right" size={15} type="monochrome" />
      </Pressable>
    </View>
  );
}

/** One request's sheet: mounted per request, so each starts from a fresh draft. */
function CustomSnoozeSheetContent() {
  const [draft, setDraft] = useState<CustomSnoozeDraft>(() => initialCustomSnoozeDraft(new Date()));
  const [error, setError] = useState<string | null>(null);
  // The day labels and the earliest day read the time the sheet opened.
  const [openedAt] = useState(() => new Date());
  const color = useThemeColor("--color-foreground") as string;
  const update = (next: CustomSnoozeDraft) => {
    setDraft(next);
    setError(null);
  };
  const submit = () => {
    const result = resolveCustomSnoozeDraft(draft, new Date());
    if ("error" in result) setError(result.error);
    else finishCustomSnooze(result.snoozedUntil);
  };
  return (
    <View className="flex-1 items-center justify-center bg-backdrop px-6">
      <View className="w-full max-w-md gap-4 rounded-[24px] bg-card px-5 pb-4 pt-5">
        <Text accessibilityRole="header" className="text-lg font-ryco-medium text-foreground">
          Custom snooze
        </Text>
        <Text className="text-sm text-foreground-secondary">
          Choose when snoozed threads return to your inbox.
        </Text>
        <View accessibilityRole="radiogroup" className="flex-row gap-2">
          {MODES.map((mode) => (
            <Choice
              key={mode.value}
              label={mode.label}
              selected={draft.mode === mode.value}
              onPress={() => update({ ...draft, mode: mode.value })}
            />
          ))}
        </View>
        {draft.mode === "date" ? (
          <View className="gap-2">
            <Stepper
              label="Day"
              value={customSnoozeDayLabel(draft, openedAt)}
              canStepBack={canStepCustomSnoozeDayBack(draft, openedAt)}
              onStep={(direction) => update(stepCustomSnoozeDay(draft, direction, openedAt))}
            />
            <Stepper
              label="Time"
              value={draft.time}
              canStepBack
              onStep={(direction) => update(stepCustomSnoozeTime(draft, direction))}
            />
          </View>
        ) : (
          <View className="gap-2">
            <TextInput
              accessibilityLabel="Snooze for"
              keyboardType="decimal-pad"
              value={draft.amount}
              onChangeText={(amount) => update({ ...draft, amount })}
              style={{ color }}
              className="min-h-12 rounded-xl bg-subtle px-3 text-base"
            />
            <View accessibilityRole="radiogroup" className="flex-row gap-2">
              {UNITS.map((unit) => (
                <Choice
                  key={unit.value}
                  label={unit.label}
                  selected={draft.unit === unit.value}
                  onPress={() => update({ ...draft, unit: unit.value })}
                />
              ))}
            </View>
          </View>
        )}
        {error ? (
          <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
            {error}
          </Text>
        ) : null}
        <View className="flex-row justify-end gap-1">
          <Pressable
            accessibilityRole="button"
            onPress={() => finishCustomSnooze(null)}
            className="min-h-10 items-center justify-center px-4"
          >
            <Text className="text-base font-ryco-medium text-foreground">Cancel</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={submit}
            className="min-h-10 items-center justify-center rounded-full bg-primary px-5"
          >
            <Text className="text-base font-ryco-medium text-primary-foreground">Snooze</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/**
 * Answers `requestCustomSnooze` ("Custom…" in an Inbox row's snooze menu).
 * Mounted once, with the Inbox.
 */
export function CustomSnoozeSheetHost() {
  const requested = useSyncExternalStore(
    subscribeCustomSnooze,
    isCustomSnoozeRequested,
    isCustomSnoozeRequested,
  );
  return (
    <Modal
      visible={requested}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={() => finishCustomSnooze(null)}
    >
      {requested ? <CustomSnoozeSheetContent /> : null}
    </Modal>
  );
}
