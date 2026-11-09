import type { ReactNode } from "react";
import { SymbolView } from "expo-symbols";
import type { Project } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { View } from "react-native";
import { AnchoredMenu } from "../../components/AnchoredMenu";
import { AppText as Text } from "../../components/AppText";
import { DeviceIcon } from "../../components/DeviceIcon";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { useThemeColor } from "../../lib/useThemeColor";
import type { ProjectEnvironment } from "../projects/projectsModel";

/** The menu row that starts a chat without a project. */
const NO_PROJECT_ACTION_ID = "no-project";

export function NewTaskProjectMenu(props: {
  readonly projects: ReadonlyArray<Project>;
  readonly environments: ReadonlyArray<ProjectEnvironment>;
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly disabled: boolean;
  readonly onSelect: (
    project: { environmentId: EnvironmentId; projectId: ProjectId } | null,
  ) => void;
  /**
   * "No project": a chat in its own folder on the chosen machine. Absent when the machine
   * cannot hold chats (an older node, or a chats folder it cannot use).
   */
  readonly chat?: { readonly selected: boolean; readonly onSelect: () => void } | undefined;
  readonly onClose: () => void;
  readonly children: (open: () => void) => ReactNode;
}) {
  const iconColor = useThemeColor("--color-icon");
  const environments = new Map(props.environments.map((entry) => [entry.environmentId, entry]));
  const projects = new Map(
    props.projects
      .filter((project) => environments.has(project.environmentId))
      .map((project) => [`${project.environmentId}:${project.id}`, project]),
  );
  return (
    <AnchoredMenu
      title="Projects"
      headerAction={{
        id: "new-project",
        title: "New Project",
        attributes: { disabled: props.disabled },
      }}
      menuWidth={360}
      className="min-w-0 max-w-full shrink"
      searchable
      searchPlaceholder="Search projects"
      emptyMessage="No projects match that search."
      actions={[
        ...(props.chat
          ? [
              {
                id: NO_PROJECT_ACTION_ID,
                title: "No project",
                subtitle: "A chat in its own folder",
                state: props.chat.selected ? ("on" as const) : ("off" as const),
                attributes: { disabled: props.disabled },
              },
            ]
          : []),
        ...[...projects.entries()].map(([key, project]) => ({
          id: key,
          title: project.name,
          subtitle: environments.get(project.environmentId)?.label,
          state:
            project.environmentId === props.environmentId &&
            project.id === props.projectId &&
            props.chat?.selected !== true
              ? ("on" as const)
              : ("off" as const),
          attributes: {
            disabled:
              props.disabled ||
              environments.get(project.environmentId)?.connectionState !== "connected",
          },
        })),
      ]}
      renderIcon={(action) => {
        if (action.id === NO_PROJECT_ACTION_ID) {
          return (
            <SymbolView name="bubble.left" size={20} tintColor={iconColor} type="monochrome" />
          );
        }
        const project = projects.get(action.id!);
        return project ? (
          <ProjectFavicon
            environmentId={project.environmentId}
            projectId={project.id}
            projectTitle={project.name}
            customAvatarContentHash={project.customAvatarContentHash}
            size={26}
          />
        ) : null;
      }}
      renderTitle={(action) => {
        if (action.id === NO_PROJECT_ACTION_ID) {
          return (
            <View className="flex-row items-center gap-2">
              <Text className="min-w-0 flex-1 text-sm font-ryco-bold" numberOfLines={1}>
                {action.title}
              </Text>
              <Text className="shrink text-xs text-foreground-muted" numberOfLines={1}>
                {action.subtitle}
              </Text>
            </View>
          );
        }
        const project = projects.get(action.id!);
        return (
          <View className="flex-row items-center gap-2">
            <Text className="min-w-0 flex-1 text-sm font-ryco-bold" numberOfLines={1}>
              {action.title}
            </Text>
            {project ? (
              <DeviceIcon environmentId={project.environmentId} label={action.subtitle} size={12} />
            ) : null}
            <Text className="max-w-[120px] shrink text-xs text-foreground-muted" numberOfLines={1}>
              {action.subtitle}
            </Text>
          </View>
        );
      }}
      onClose={props.onClose}
      onPressAction={({ nativeEvent }) => {
        if (props.disabled) return;
        if (nativeEvent.event === "new-project") props.onSelect(null);
        else if (nativeEvent.event === NO_PROJECT_ACTION_ID) props.chat?.onSelect();
        else {
          const project = projects.get(nativeEvent.event);
          if (project && environments.get(project.environmentId)?.connectionState === "connected")
            props.onSelect({ environmentId: project.environmentId, projectId: project.id });
        }
      }}
    >
      {props.children}
    </AnchoredMenu>
  );
}
