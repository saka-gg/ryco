import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { BottomSheet } from "../../components/BottomSheet";
import { useThemeColor } from "../../lib/useThemeColor";
import { resolveThreadRename } from "./threadHeaderMenuModel";

/**
 * Renaming a chat from the ⋯ menu where there is no native text prompt (Android; iOS uses
 * `Alert.prompt`): one field with the current title and Save. Each opening starts from the
 * chat's title as it is then.
 */
export function ThreadRenameSheet(props: {
  readonly visible: boolean;
  readonly currentTitle: string;
  readonly onClose: () => void;
  readonly onSave: (title: string) => void;
}) {
  // A new form per opening (adjusted while rendering), so the field starts from the title as it
  // is now; it stays mounted while the card slides out.
  const [opening, setOpening] = useState({ count: 0, visible: props.visible });
  if (opening.visible !== props.visible) {
    setOpening({ count: opening.count + (props.visible ? 1 : 0), visible: props.visible });
  }
  return (
    <BottomSheet visible={props.visible} onClose={props.onClose} accessibilityLabel="Rename chat">
      <ThreadRenameForm
        key={opening.count}
        currentTitle={props.currentTitle}
        onSave={(title) => {
          props.onClose();
          props.onSave(title);
        }}
      />
    </BottomSheet>
  );
}

function ThreadRenameForm(props: {
  readonly currentTitle: string;
  readonly onSave: (title: string) => void;
}) {
  const textColor = String(useThemeColor("--color-foreground"));
  const placeholderColor = String(useThemeColor("--color-placeholder"));
  const [value, setValue] = useState(props.currentTitle);
  const next = resolveThreadRename(props.currentTitle, value);
  const save = () => {
    if (next !== null) props.onSave(next);
  };
  return (
    <View className="gap-3 pb-2">
      <Text className="text-lg font-ryco-bold text-foreground">Rename chat</Text>
      <TextInput
        accessibilityLabel="Chat title"
        value={value}
        onChangeText={setValue}
        autoFocus
        selectTextOnFocus
        placeholder="Chat title"
        placeholderTextColor={placeholderColor}
        returnKeyType="done"
        onSubmitEditing={save}
        className="min-h-12 rounded-2xl border border-border bg-card px-4 py-3 font-sans text-base"
        style={{ color: textColor }}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save chat title"
        disabled={next === null}
        onPress={save}
        className="h-12 items-center justify-center rounded-full bg-primary active:opacity-80 disabled:opacity-40"
      >
        <Text className="text-sm font-ryco-bold text-primary-foreground">Save</Text>
      </Pressable>
    </View>
  );
}
