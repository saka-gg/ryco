import { IconGitFork, IconMessages } from "@tabler/icons-react-native";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { LegendList, type LegendListRenderItemProps } from "@legendapp/list/react-native";
import { DeviceIcon } from "../../components/DeviceIcon";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { EmptyState } from "../../components/EmptyState";
import { useThemeColor } from "../../lib/useThemeColor";
import { HOME_LIST_PADDING_BOTTOM } from "../home/homeChromeModel";
import {
  projectMachineStatusLabel,
  projectRowAccessibilityLabel,
  type ProjectListRow,
  type ProjectRowMachine,
} from "./projectsModel";

function MachineMetadata(props: { readonly machine: ProjectRowMachine }) {
  const { machine } = props;
  const showStatus = machine.connectionState !== "connected" || machine.stale;
  return (
    <View className="min-w-0 max-w-full flex-row flex-wrap items-center gap-1">
      <DeviceIcon environmentId={machine.environmentId} label={machine.label} size={12} />
      <Text className="max-w-[140px] shrink text-2xs text-foreground-muted" numberOfLines={1}>
        {machine.label}
      </Text>
      {showStatus ? (
        <Text className="shrink text-2xs text-foreground-tertiary">
          · {projectMachineStatusLabel(machine)}
        </Text>
      ) : null}
      {machine.role === "viewer" ? (
        <Text className="text-2xs text-foreground-tertiary">· Viewer</Text>
      ) : null}
    </View>
  );
}

function ProjectRow(props: { readonly row: ProjectListRow; readonly onPress?: () => void }) {
  const iconColor = useThemeColor("--color-icon-subtle");
  const { row } = props;
  const content = (
    <>
      <View className="flex-row items-center gap-2.5">
        <ProjectFavicon
          environmentId={row.open.environmentId}
          projectId={row.open.projectId}
          customAvatarContentHash={row.customAvatarContentHash}
          projectTitle={row.title}
          size={24}
        />
        <Text
          className="min-w-0 flex-1 font-ryco-medium text-[16px] leading-[21px] text-foreground"
          numberOfLines={2}
        >
          {row.title}
        </Text>
        {props.onPress ? (
          <SymbolView
            name="chevron.right"
            size={13}
            tintColor={iconColor as string}
            type="monochrome"
          />
        ) : null}
      </View>
      <Text
        className="font-mono text-2xs text-foreground-tertiary"
        numberOfLines={1}
        ellipsizeMode="middle"
      >
        {row.path}
      </Text>
      <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1.5">
        <View className="flex-row items-center gap-1">
          <IconGitFork size={13} strokeWidth={1.75} color={iconColor as string} />
          <Text className="text-2xs text-foreground-muted">
            {row.worktreeCount} worktree{row.worktreeCount === 1 ? "" : "s"}
          </Text>
        </View>
        <View className="flex-row items-center gap-1">
          <IconMessages size={13} strokeWidth={1.75} color={iconColor as string} />
          <Text className="text-2xs text-foreground-muted">
            {row.threadCount} task{row.threadCount === 1 ? "" : "s"}
          </Text>
        </View>
        {row.machines.map((machine) => (
          <MachineMetadata
            key={`${machine.environmentId}:${machine.projectId}`}
            machine={machine}
          />
        ))}
      </View>
    </>
  );
  const className = "mx-4 mb-2 gap-2 rounded-2xl bg-card px-3.5 py-3";
  if (!props.onPress) {
    return (
      <View accessible accessibilityLabel={projectRowAccessibilityLabel(row)} className={className}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={projectRowAccessibilityLabel(row)}
      onPress={props.onPress}
      className={`${className} active:bg-card-alt`}
    >
      {content}
    </Pressable>
  );
}

export function ProjectsScreen(props: {
  readonly filterKey?: string;
  readonly rows: ReadonlyArray<ProjectListRow>;
  readonly hasMachines: boolean;
  readonly initialScrollOffset?: number;
  readonly onAddProject: () => void;
  readonly onOpenProject?: (row: ProjectListRow) => void;
  readonly onAddMachine: () => void;
  readonly onScrollOffset?: (offset: number) => void;
}) {
  const primaryForeground = useThemeColor("--color-primary-foreground");
  const renderItem = ({ item }: LegendListRenderItemProps<ProjectListRow>) => (
    <ProjectRow
      row={item}
      onPress={props.onOpenProject ? () => props.onOpenProject?.(item) : undefined}
    />
  );

  return (
    <LegendList
      key={props.filterKey}
      data={props.rows}
      renderItem={renderItem}
      keyExtractor={(item) => item.key}
      recycleItems
      maintainVisibleContentPosition
      initialScrollOffset={props.initialScrollOffset}
      onScroll={(event) => props.onScrollOffset?.(event.nativeEvent.contentOffset.y)}
      scrollEventThrottle={32}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="never"
      contentContainerStyle={{ paddingBottom: HOME_LIST_PADDING_BOTTOM }}
      ListHeaderComponent={
        props.hasMachines && props.rows.length > 0 ? (
          <View className="px-4 pt-3 pb-3">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add project"
              onPress={props.onAddProject}
              className="h-12 flex-row items-center justify-center gap-2 rounded-full bg-primary px-5 active:opacity-80"
            >
              <SymbolView
                name="plus"
                size={17}
                tintColor={primaryForeground as string}
                type="monochrome"
              />
              <Text className="text-sm font-ryco-bold text-primary-foreground">Add project</Text>
            </Pressable>
          </View>
        ) : null
      }
      ListEmptyComponent={
        <View className="px-2 py-14">
          <EmptyState
            variant="plain"
            title={props.hasMachines ? "No projects yet" : "Add a machine"}
            detail={
              props.hasMachines
                ? "Add a remote workspace on one of your connected machines to begin."
                : "Use your Hub or pair a machine directly before choosing a project."
            }
            actionLabel={props.hasMachines ? "Add project" : "Add a machine"}
            onAction={props.hasMachines ? props.onAddProject : props.onAddMachine}
          />
        </View>
      }
    />
  );
}
