import { IconGitFork } from "../../components/icons";
import { useRef, useState, type ReactNode } from "react";
import type { DraftWorktreeSource } from "@ryco/client-runtime/state/composer";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";

import type { SidebarWorktreeSummary } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ProjectId, WorktreeId } from "@ryco/contracts";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { OptionRow } from "../../components/OptionRow";
import { useThemeColor } from "../../lib/useThemeColor";
import { NewTaskSourcePicker } from "./NewTaskSourcePicker";

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
  /** The project's checkout, where branches, pull requests and issues are listed. */
  readonly cwd: string | null;
  /** A pull request, issue or Jira item the node makes the task's worktree for. */
  readonly source: DraftWorktreeSource | null;
  readonly onSelectSource: (source: DraftWorktreeSource | null) => void;
  readonly onClose: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const close = () => {
    setPicking(false);
    props.onClose();
  };
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
      onRequestClose={close}
    >
      <View className="flex-1 bg-screen">
        <View className="flex-row items-center gap-2 px-4 pt-5 pb-3">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={() => (picking ? setPicking(false) : close())}
            className="h-11 w-11 items-center justify-center rounded-full bg-subtle active:opacity-70"
          >
            <SymbolView name="chevron.left" size={18} tintColor={iconColor} type="monochrome" />
          </Pressable>
          <Text className="min-w-0 flex-1 text-lg font-ryco-bold text-foreground" numberOfLines={1}>
            {picking ? "Start from" : "Workspace"}
          </Text>
          {picking ? null : (
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
          )}
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
          {picking ? (
            <NewTaskSourcePicker
              environmentId={props.environmentId}
              projectId={props.projectId}
              cwd={props.cwd}
              initialKind="pr"
              onPickBranch={(branch) => {
                props.onSelectSource(null);
                props.onSelectWorktree({ kind: "new" });
                props.onChangeBaseBranch(branch);
                setPicking(false);
              }}
              onPickSource={(source) => {
                props.onSelectSource(source);
                close();
              }}
            />
          ) : props.environmentId ? (
            <View className="gap-2">
              {props.source ? (
                <OptionRow
                  icon={
                    <SymbolView
                      name="arrow.triangle.pull"
                      size={20}
                      tintColor={iconColor}
                      type="monochrome"
                    />
                  }
                  label={props.source.label}
                  detail="A worktree for it is made when you send. Tap to remove."
                  selected
                  onPress={() => props.onSelectSource(null)}
                />
              ) : null}
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
              {props.cwd ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setPicking(true)}
                  className="min-h-12 flex-row items-center gap-3 rounded-2xl px-4 py-2.5 active:bg-subtle"
                >
                  <SymbolView
                    name="arrow.triangle.branch"
                    size={18}
                    tintColor={iconColor}
                    type="monochrome"
                  />
                  <Text className="min-w-0 flex-1 text-sm text-foreground">
                    Start from a branch, pull request, issue or Jira item
                  </Text>
                  <SymbolView
                    name="chevron.right"
                    size={11}
                    tintColor={iconColor}
                    type="monochrome"
                  />
                </Pressable>
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
