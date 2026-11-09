import { MenuView } from "@react-native-menu/menu";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { cn } from "../../../lib/cn";
import { useThemeColor } from "../../../lib/useThemeColor";

/**
 * A settings row with a text value that edits in place: tap to open a field (one line, or
 * several with `multiline`), Save or Cancel. Empty saves "" (the node's default).
 */
export function TextSettingRow(props: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
  /** What the row says while the value is empty ("Default"). */
  readonly emptyLabel: string;
  readonly placeholder?: string;
  readonly multiline?: boolean;
  readonly maxLength?: number;
  readonly first?: boolean;
  readonly disabled?: boolean;
  /** Why the draft can't be saved, or null. */
  readonly validate?: (draft: string) => string | null;
  readonly onSave: (value: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.value);
  const [saving, setSaving] = useState(false);
  const placeholder = useThemeColor("--color-placeholder") as string;
  const foreground = useThemeColor("--color-foreground") as string;
  const chevron = useThemeColor("--color-icon-subtle") as string;
  const trimmed = draft.trim();
  const problem = props.validate ? props.validate(trimmed) : null;
  const open = () => {
    if (props.disabled) return;
    setDraft(props.value);
    setEditing(true);
  };
  const save = async () => {
    if (problem || saving) return;
    if (trimmed === props.value) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const ok = await props.onSave(trimmed);
    setSaving(false);
    if (ok) {
      void Haptics.selectionAsync();
      setEditing(false);
    }
  };
  return (
    <View className={cn(!props.first && "border-t border-border-subtle")}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.label}: ${props.value || props.emptyLabel}`}
        disabled={props.disabled}
        onPress={editing ? () => setEditing(false) : open}
        className={cn(
          "min-h-[52px] flex-row items-center gap-3 px-4 py-3 active:bg-subtle",
          props.disabled && "opacity-40",
        )}
      >
        <View className="min-w-0 flex-1">
          <Text className="text-[17px] text-foreground">{props.label}</Text>
          {props.detail && !editing ? (
            <Text className="mt-0.5 text-xs leading-4 text-foreground-muted">{props.detail}</Text>
          ) : null}
        </View>
        {!editing ? (
          <Text
            className="max-w-[50%] shrink text-[15px] text-foreground-muted"
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {props.value || props.emptyLabel}
          </Text>
        ) : null}
        <SymbolView
          name={editing ? "chevron.up" : "pencil"}
          size={13}
          weight="semibold"
          tintColor={chevron}
        />
      </Pressable>
      {editing ? (
        <View className="gap-2 px-4 pb-3">
          {props.detail ? (
            <Text className="text-xs leading-4 text-foreground-muted">{props.detail}</Text>
          ) : null}
          <TextInput
            autoFocus
            value={draft}
            onChangeText={setDraft}
            placeholder={props.placeholder}
            placeholderTextColor={placeholder}
            multiline={props.multiline}
            maxLength={props.maxLength}
            autoCapitalize={props.multiline ? "sentences" : "none"}
            autoCorrect={props.multiline === true}
            textAlignVertical={props.multiline ? "top" : "center"}
            onSubmitEditing={props.multiline ? undefined : () => void save()}
            className={cn(
              "rounded-xl bg-subtle px-3 font-sans text-[15px]",
              props.multiline ? "min-h-[110px] py-2.5 leading-[21px]" : "h-11",
            )}
            style={{ color: foreground }}
          />
          {problem ? <Text className="text-xs text-danger-foreground">{problem}</Text> : null}
          <View className="flex-row justify-end gap-2">
            <Pressable
              accessibilityRole="button"
              onPress={() => setEditing(false)}
              className="h-9 justify-center rounded-full bg-card-alt px-4 active:opacity-70"
            >
              <Text className="text-[14px] font-ryco-bold text-foreground">Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: problem !== null || saving }}
              disabled={problem !== null || saving}
              onPress={() => void save()}
              className={cn(
                "h-9 justify-center rounded-full bg-primary px-4 active:opacity-70",
                (problem !== null || saving) && "opacity-50",
              )}
            >
              <Text className="text-[14px] font-ryco-bold text-primary-foreground">
                {saving ? "Saving…" : "Save"}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** A settings row whose value is one of a few choices, picked from a native menu. */
export function ChoiceSettingRow<T extends string>(props: {
  readonly label: string;
  readonly detail?: string;
  readonly value: T;
  readonly options: ReadonlyArray<{
    readonly value: T;
    readonly label: string;
    readonly description?: string;
  }>;
  readonly first?: boolean;
  readonly disabled?: boolean;
  readonly onPick: (value: T) => void;
}) {
  const chevron = useThemeColor("--color-icon-subtle") as string;
  const current = props.options.find((option) => option.value === props.value);
  const row = (
    <View
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${props.label}: ${current?.label ?? props.value}`}
      className={cn(
        "min-h-[52px] flex-row items-center gap-3 px-4 py-3",
        !props.first && "border-t border-border-subtle",
        props.disabled && "opacity-40",
      )}
    >
      <View className="min-w-0 flex-1">
        <Text className="text-[17px] text-foreground">{props.label}</Text>
        {props.detail ? (
          <Text className="mt-0.5 text-xs leading-4 text-foreground-muted">{props.detail}</Text>
        ) : null}
      </View>
      <Text className="max-w-[50%] shrink text-[15px] text-foreground-muted" numberOfLines={1}>
        {current?.label ?? props.value}
      </Text>
      <SymbolView name="chevron.up.chevron.down" size={12} tintColor={chevron} />
    </View>
  );
  if (props.disabled) return row;
  return (
    <MenuView
      shouldOpenOnLongPress={false}
      actions={props.options.map((option) => ({
        id: option.value,
        title: option.label,
        ...(option.description ? { subtitle: option.description } : {}),
        state: option.value === props.value ? ("on" as const) : ("off" as const),
      }))}
      onPressAction={({ nativeEvent }) => {
        const picked = props.options.find((option) => option.value === nativeEvent.event);
        if (!picked || picked.value === props.value) return;
        void Haptics.selectionAsync();
        props.onPick(picked.value);
      }}
    >
      {row}
    </MenuView>
  );
}
