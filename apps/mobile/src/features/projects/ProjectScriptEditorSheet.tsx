import {
  PROJECT_SCRIPT_ICONS,
  projectScriptDraftError,
  type ProjectScriptDraft,
} from "@ryco/client-runtime/projectSettings/scripts";
import type { ProjectScript, ProjectScriptIcon } from "@ryco/contracts";
import { useState } from "react";
import { Alert, Modal, Pressable, ScrollView, Switch, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { useThemeColor } from "../../lib/useThemeColor";
import { PROJECT_SCRIPT_SYMBOLS } from "./projectSettingsModel";

export interface ProjectScriptEditorTarget {
  /** The action being edited, or null to add one. */
  readonly script: ProjectScript | null;
}

/**
 * Add or edit one project action: its name, the command it runs, an icon and whether it sets up
 * new worktrees (only one does; turning it on here turns it off on the others). Keyboard
 * shortcuts are a desktop setting and are left as they are.
 */
export function ProjectScriptEditorSheet(props: {
  readonly visible: boolean;
  readonly target: ProjectScriptEditorTarget | null;
  /** Bumps on every open, so the fields start from the action again. */
  readonly token: number;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onSave: (draft: ProjectScriptDraft) => void;
  readonly onDelete: (script: ProjectScript) => void;
}) {
  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      {props.target ? (
        <ScriptEditorBody
          key={props.token}
          script={props.target.script}
          busy={props.busy}
          error={props.error}
          onClose={props.onClose}
          onSave={props.onSave}
          onDelete={props.onDelete}
        />
      ) : (
        <View className="flex-1 bg-screen" />
      )}
    </Modal>
  );
}

function ScriptEditorBody(props: {
  readonly script: ProjectScript | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onSave: (draft: ProjectScriptDraft) => void;
  readonly onDelete: (script: ProjectScript) => void;
}) {
  const { script } = props;
  const [name, setName] = useState(script?.name ?? "");
  const [command, setCommand] = useState(script?.command ?? "");
  const [icon, setIcon] = useState<ProjectScriptIcon>(script?.icon ?? "play");
  const [runOnWorktreeCreate, setRunOnWorktreeCreate] = useState(
    script?.runOnWorktreeCreate ?? false,
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const iconColor = useThemeColor("--color-icon");
  const selectedIconColor = useThemeColor("--color-primary-foreground");

  const save = () => {
    const draftError = projectScriptDraftError({ name, command });
    setValidationError(draftError);
    if (draftError) return;
    props.onSave({ name: name.trim(), command: command.trim(), icon, runOnWorktreeCreate });
  };

  const confirmDelete = () => {
    if (!script) return;
    Alert.alert(`Delete "${script.name}"?`, "The action is removed from this project.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => props.onDelete(script) },
    ]);
  };

  const error = validationError ?? props.error;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      className="flex-1 bg-screen"
      contentContainerStyle={{ padding: 20, gap: 18, paddingBottom: 48 }}
    >
      <View className="flex-row items-center gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          className="h-11 min-w-11 items-center justify-center rounded-full px-2 active:bg-subtle"
          onPress={props.onClose}
        >
          <Text className="font-ryco-medium text-base text-foreground">Cancel</Text>
        </Pressable>
        <Text className="flex-1 text-center text-lg font-ryco-bold text-foreground">
          {script ? "Edit action" : "Add action"}
        </Text>
        <View className="h-11 min-w-11" />
      </View>

      {error ? <ErrorBanner message={error} /> : null}

      <View className="gap-2">
        <Text className="px-1 text-sm font-ryco-medium text-foreground-muted">Name</Text>
        <AppTextInput
          accessibilityLabel="Action name"
          autoFocus={script === null}
          value={name}
          onChangeText={setName}
          placeholder="Test"
          returnKeyType="next"
        />
      </View>

      <View className="gap-2">
        <Text className="px-1 text-sm font-ryco-medium text-foreground-muted">Command</Text>
        <AppTextInput
          accessibilityLabel="Command"
          value={command}
          onChangeText={setCommand}
          placeholder="bun run test"
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          multiline
          className="min-h-24 font-mono text-sm"
          textAlignVertical="top"
        />
      </View>

      <View className="gap-2">
        <Text className="px-1 text-sm font-ryco-medium text-foreground-muted">Icon</Text>
        <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-2">
          {PROJECT_SCRIPT_ICONS.map((entry) => {
            const selected = entry.id === icon;
            return (
              <Pressable
                key={entry.id}
                accessibilityRole="radio"
                accessibilityLabel={entry.label}
                accessibilityState={{ checked: selected }}
                onPress={() => setIcon(entry.id)}
                className={`h-11 flex-row items-center gap-2 rounded-full px-4 ${
                  selected ? "bg-primary" : "bg-card active:bg-card-alt"
                }`}
              >
                <SymbolView
                  name={PROJECT_SCRIPT_SYMBOLS[entry.id]}
                  size={15}
                  tintColor={(selected ? selectedIconColor : iconColor) as string}
                  type="monochrome"
                />
                <Text
                  className={`text-sm font-ryco-medium ${
                    selected ? "text-primary-foreground" : "text-foreground"
                  }`}
                >
                  {entry.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View className="flex-row items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3">
        <View className="min-w-0 flex-1">
          <Text className="text-[17px] text-foreground">Set up new worktrees</Text>
          <Text className="mt-0.5 text-xs text-foreground-muted">
            Runs once on every new worktree. Only one action does.
          </Text>
        </View>
        <Switch
          accessibilityLabel="Set up new worktrees"
          value={runOnWorktreeCreate}
          onValueChange={setRunOnWorktreeCreate}
        />
      </View>

      <Pressable
        accessibilityRole="button"
        disabled={props.busy}
        onPress={save}
        className="h-12 items-center justify-center rounded-full bg-primary px-5 active:opacity-80 disabled:opacity-40"
      >
        <Text className="text-base font-ryco-bold text-primary-foreground">
          {props.busy ? "Saving…" : script ? "Save" : "Add action"}
        </Text>
      </Pressable>
      {script ? (
        <Pressable
          accessibilityRole="button"
          disabled={props.busy}
          onPress={confirmDelete}
          className="h-12 items-center justify-center rounded-full px-5 active:bg-subtle disabled:opacity-40"
        >
          <Text className="text-base font-ryco-bold text-danger-foreground">Delete action</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}
