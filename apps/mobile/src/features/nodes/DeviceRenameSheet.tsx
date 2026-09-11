import { useState } from "react";
import { Modal, Pressable, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { useThemeColor } from "../../lib/useThemeColor";

export function DeviceRenameSheet(props: {
  readonly label: string;
  readonly onClose: () => void;
  readonly onSave: (label: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(props.label);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const color = useThemeColor("--color-foreground") as string;
  const name = draft.trim();
  const canSave = !saving && name.length > 0 && name.length <= 100 && name !== props.label;
  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await props.onSave(name);
      props.onClose();
    } catch {
      setError(
        "Could not rename the device. Check your connection and owner access, then try again.",
      );
      setSaving(false);
    }
  };
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => {
        if (!saving) props.onClose();
      }}
    >
      <View className="flex-1 gap-5 bg-screen px-5 pt-5">
        <Text className="text-lg font-ryco-bold text-foreground">Rename {props.label}</Text>
        <Text className="font-sans text-base text-foreground-muted">
          This name is shown to everyone who can access the device. Its projects and conversations
          stay in place.
        </Text>
        <TextInput
          autoFocus
          accessibilityLabel="Device name"
          value={draft}
          onChangeText={setDraft}
          maxLength={100}
          editable={!saving}
          style={{ color }}
          className="min-h-14 rounded-2xl border border-border bg-card px-4 py-3 font-sans text-base"
          returnKeyType="done"
          onSubmitEditing={() => void save()}
        />
        {error && <ErrorBanner message={error} />}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save device name"
          disabled={!canSave}
          onPress={() => void save()}
          className="h-12 items-center justify-center rounded-full bg-primary px-5 disabled:opacity-40"
        >
          <Text className="text-base font-ryco-bold text-primary-foreground">
            {saving ? "Saving…" : "Save"}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel rename"
          disabled={saving}
          onPress={props.onClose}
          className="h-12 items-center justify-center rounded-full border border-border"
        >
          <Text className="text-base font-ryco-medium text-foreground">Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}
