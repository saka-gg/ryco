import { IconGitFork } from "@tabler/icons-react-native";
import { useRef, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";

import type { SidebarWorktreeSummary } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ProjectId, WorktreeId } from "@ryco/contracts";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";

function OptionRow(props: {
  readonly icon?: ReactNode;
  readonly label: string;
  readonly detail: string;
  readonly selected: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor("--color-icon");
  return (
    <Pressable
      accessibilityLabel={[props.label, props.detail].filter(Boolean).join(", ")}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={`min-h-14 flex-row items-center gap-3 rounded-2xl border px-4 py-3 active:bg-subtle ${
        props.selected ? "border-foreground bg-card-alt" : "border-border bg-card"
      } ${props.disabled ? "opacity-40" : ""}`}
    >
      {props.icon}
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base font-ryco-bold text-foreground" numberOfLines={1}>
          {props.label}
        </Text>
        <Text className="text-xs font-ryco-medium text-foreground-muted" numberOfLines={1}>
          {props.detail}
        </Text>
      </View>
      {props.selected ? (
        <SymbolView name="checkmark" size={16} tintColor={iconColor as string} type="monochrome" />
      ) : null}
    </Pressable>
  );
}

export type NewTaskWorktreeSelection =
  | { readonly kind: "local" }
  | { readonly kind: "existing"; readonly worktreeId: WorktreeId }
  | { readonly kind: "new" };

export function NewTaskContextSheet(props: {
  readonly visible: boolean;
  readonly currentBranch: string | null;
  readonly baseBranch: string;
  readonly onChangeBaseBranch: (branch: string) => void;
  readonly worktrees: ReadonlyArray<SidebarWorktreeSummary>;
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly worktree: NewTaskWorktreeSelection;
  readonly newBranch: string;
  readonly onSelectWorktree: (worktree: NewTaskWorktreeSelection) => void;
  readonly onChangeNewBranch: (branch: string) => void;
  readonly onClose: () => void;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const placeholderColor = useThemeColor("--color-placeholder");
  const textColor = useThemeColor("--color-foreground");
  const iconColor = useThemeColor("--color-icon");
  const primaryForeground = useThemeColor("--color-primary-foreground");
  const worktrees = props.worktrees.filter(
    (worktree) =>
      worktree.environmentId === props.environmentId &&
      worktree.projectId === props.projectId &&
      worktree.archivedAt === null,
  );

  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <View className="flex-1 bg-screen">
        <View className="flex-row items-center gap-2 px-4 pt-5 pb-3">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={props.onClose}
            className="h-11 w-11 items-center justify-center rounded-full bg-subtle active:opacity-70"
          >
            <SymbolView name="chevron.left" size={18} tintColor={iconColor} type="monochrome" />
          </Pressable>
          <Text className="min-w-0 flex-1 text-lg font-ryco-bold text-foreground" numberOfLines={1}>
            Workspace
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={props.worktree.kind === "new" ? "Done" : "New Worktree"}
            onPress={() => {
              if (props.worktree.kind === "new") props.onClose();
              else {
                props.onSelectWorktree({ kind: "new" });
                scrollRef.current?.scrollTo({ y: 0, animated: false });
              }
            }}
            className="h-11 flex-row items-center gap-2 rounded-full bg-primary px-4 active:opacity-80"
          >
            <Text className="text-sm font-ryco-bold text-primary-foreground">
              {props.worktree.kind === "new" ? "Done" : "New Worktree"}
            </Text>
            {props.worktree.kind !== "new" ? (
              <SymbolView name="plus" size={15} tintColor={primaryForeground} type="monochrome" />
            ) : null}
          </Pressable>
        </View>
        <ScrollView
          ref={scrollRef}
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets
          className="flex-1 bg-screen"
          contentContainerStyle={{ padding: 20, gap: 20, paddingBottom: 44 }}
        >
          {props.environmentId ? (
            <View className="gap-2">
              <OptionRow
                icon={
                  <SymbolView name="folder" size={22} tintColor={iconColor} type="monochrome" />
                }
                label="Project root"
                detail={
                  props.currentBranch ? `On ${props.currentBranch}` : "Use the current checkout"
                }
                selected={props.worktree.kind === "local"}
                onPress={() => {
                  props.onSelectWorktree({ kind: "local" });
                  props.onClose();
                }}
              />

              {props.worktree.kind === "new" ? (
                <View className="gap-2 pt-2">
                  <Text className="px-1 text-sm text-foreground-muted">New branch name</Text>
                  <TextInput
                    accessibilityLabel="New branch name"
                    value={props.newBranch}
                    onChangeText={props.onChangeNewBranch}
                    placeholder="feat/mobile"
                    placeholderTextColor={placeholderColor as string}
                    autoCapitalize="none"
                    autoCorrect={false}
                    className="min-h-14 rounded-2xl border border-border bg-card px-4 py-3 font-mono text-base"
                    style={{ color: textColor as string }}
                  />
                  <Text className="px-1 pt-2 text-sm text-foreground-muted">From branch</Text>
                  <TextInput
                    accessibilityLabel="Base branch"
                    value={props.baseBranch}
                    onChangeText={props.onChangeBaseBranch}
                    placeholder={props.currentBranch ?? "Current branch (HEAD)"}
                    placeholderTextColor={placeholderColor as string}
                    autoCapitalize="none"
                    autoCorrect={false}
                    className="min-h-14 rounded-2xl border border-border bg-card px-4 py-3 font-mono text-base"
                    style={{ color: textColor as string }}
                  />
                  <Text className="px-1 text-xs text-foreground-muted">
                    Created when you send. Leave the source empty to use the current checkout.
                  </Text>
                </View>
              ) : null}
              {worktrees.map((worktree) => (
                <OptionRow
                  key={worktree.id}
                  icon={<IconGitFork size={22} color={iconColor as string} />}
                  label={worktree.title?.trim() || worktree.branch}
                  detail={
                    worktree.title?.trim() && worktree.title.trim() !== worktree.branch
                      ? worktree.branch
                      : (worktree.worktreePath ?? "Worktree")
                  }
                  selected={
                    props.worktree.kind === "existing" && props.worktree.worktreeId === worktree.id
                  }
                  onPress={() => {
                    props.onSelectWorktree({ kind: "existing", worktreeId: worktree.id });
                    props.onClose();
                  }}
                />
              ))}
            </View>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}
