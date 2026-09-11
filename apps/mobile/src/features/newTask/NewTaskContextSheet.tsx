import { DeviceIcon } from "../../components/DeviceIcon";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";

import type { Project, SidebarWorktreeSummary } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ProjectId, WorktreeId } from "@ryco/contracts";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import type { ProjectEnvironment } from "../projects/projectsModel";

function OptionRow(props: {
  readonly environmentId?: EnvironmentId;
  readonly label: string;
  readonly detail: string;
  readonly selected: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor("--color-icon");
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={`min-h-14 flex-row items-center gap-3 rounded-2xl border px-4 py-3 active:bg-subtle ${
        props.selected ? "border-foreground bg-card-alt" : "border-border bg-card"
      } ${props.disabled ? "opacity-40" : ""}`}
    >
      {props.environmentId && (
        <DeviceIcon environmentId={props.environmentId} label={props.label} />
      )}
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
  readonly environments: ReadonlyArray<ProjectEnvironment>;
  readonly projects: ReadonlyArray<Project>;
  readonly worktrees: ReadonlyArray<SidebarWorktreeSummary>;
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly worktree: NewTaskWorktreeSelection;
  readonly newBranch: string;
  readonly onSelectEnvironment: (environmentId: EnvironmentId) => void;
  readonly onSelectProject: (projectId: ProjectId | null) => void;
  readonly onSelectWorktree: (worktree: NewTaskWorktreeSelection) => void;
  readonly onChangeNewBranch: (branch: string) => void;
  readonly onClose: () => void;
}) {
  const placeholderColor = useThemeColor("--color-placeholder");
  const textColor = useThemeColor("--color-foreground");
  const projects = props.projects.filter(
    (project) => project.environmentId === props.environmentId,
  );
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
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        className="flex-1 bg-screen"
        contentContainerStyle={{ padding: 20, gap: 20, paddingBottom: 44 }}
      >
        <View className="flex-row items-center gap-3">
          <Text className="flex-1 text-xl font-ryco-bold text-foreground">Task context</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Done"
            onPress={props.onClose}
            className="h-11 items-center justify-center rounded-full bg-primary px-5 active:opacity-80"
          >
            <Text className="text-sm font-ryco-bold text-primary-foreground">Done</Text>
          </Pressable>
        </View>

        <View className="gap-2">
          <Text className="px-1 text-sm font-ryco-bold text-foreground-muted">Node</Text>
          {props.environments.map((environment) => (
            <OptionRow
              key={environment.environmentId}
              environmentId={environment.environmentId}
              label={environment.label}
              detail={
                environment.connectionState === "connected"
                  ? "Ready for changes"
                  : environment.connectionState === "read-only"
                    ? "Read-only"
                    : environment.connectionState === "reconnecting"
                      ? "Reconnecting"
                      : "Offline"
              }
              selected={environment.environmentId === props.environmentId}
              disabled={environment.connectionState !== "connected"}
              onPress={() => props.onSelectEnvironment(environment.environmentId)}
            />
          ))}
        </View>

        {props.environmentId ? (
          <View className="gap-2">
            <Text className="px-1 text-sm font-ryco-bold text-foreground-muted">Project</Text>
            {projects.map((project) => (
              <OptionRow
                key={project.id}
                label={project.name}
                detail={project.cwd}
                selected={project.id === props.projectId}
                onPress={() => props.onSelectProject(project.id)}
              />
            ))}
            <OptionRow
              label="New project"
              detail="Enter a workspace path in the composer"
              selected={props.projectId === null}
              onPress={() => props.onSelectProject(null)}
            />
          </View>
        ) : null}

        {props.environmentId ? (
          <View className="gap-2">
            <Text className="px-1 text-sm font-ryco-bold text-foreground-muted">Workspace</Text>
            <OptionRow
              label="Local workspace"
              detail="Use the project root"
              selected={props.worktree.kind === "local"}
              onPress={() => props.onSelectWorktree({ kind: "local" })}
            />
            {worktrees.map((worktree) => (
              <OptionRow
                key={worktree.id}
                label={worktree.title?.trim() || worktree.branch}
                detail={worktree.branch}
                selected={
                  props.worktree.kind === "existing" && props.worktree.worktreeId === worktree.id
                }
                onPress={() =>
                  props.onSelectWorktree({ kind: "existing", worktreeId: worktree.id })
                }
              />
            ))}
            <OptionRow
              label="New worktree"
              detail="Create a node-managed branch workspace"
              selected={props.worktree.kind === "new"}
              onPress={() => props.onSelectWorktree({ kind: "new" })}
            />
            {props.worktree.kind === "new" ? (
              <TextInput
                autoFocus
                value={props.newBranch}
                onChangeText={props.onChangeNewBranch}
                placeholder="feat/mobile"
                placeholderTextColor={placeholderColor as string}
                autoCapitalize="none"
                autoCorrect={false}
                className="min-h-14 rounded-2xl border border-border bg-card px-4 py-3 font-mono text-base"
                style={{ color: textColor as string }}
              />
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </Modal>
  );
}
