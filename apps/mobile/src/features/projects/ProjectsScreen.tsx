import { LegendList, type LegendListRenderItemProps } from "@legendapp/list/react-native";
import { DeviceIcon } from "../../components/DeviceIcon";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { EmptyState } from "../../components/EmptyState";
import { useThemeColor } from "../../lib/useThemeColor";
import { HOME_LIST_PADDING_BOTTOM } from "../home/homeChromeModel";
import { NODE_TRUST_ACCOUNT_LABEL, NODE_TRUST_UNVERIFIED_LABEL } from "../home/nodeTrustModel";
import {
  projectMachineStatusLabel,
  projectRowAccessibilityLabel,
  type ProjectListRow,
  type ProjectRowMachine,
} from "./projectsModel";

/**
 * One machine the project lives on. A row carries one of these per contributing
 * machine instead of sitting under a node header — the machine is provenance on
 * the row now, so a merged cross-machine row states both of its origins inline.
 */
function MachineProvenance(props: { readonly machine: ProjectRowMachine }) {
  // The markers are siblings of the label text, not nested spans: a single
  // numberOfLines={1} Text tail-ellipsizes its END, and the end is exactly
  // where "Not verified" would sit — a long machine label must shorten itself,
  // never the mandatory §13.1 claim beside it.
  return (
    <View className="flex-row items-center gap-1">
      <DeviceIcon
        environmentId={props.machine.environmentId}
        label={props.machine.label}
        size={12}
      />
      <Text
        className="min-w-0 shrink text-2xs font-ryco-medium text-foreground-muted"
        numberOfLines={1}
      >
        {props.machine.label} · {projectMachineStatusLabel(props.machine)}
      </Text>
      {props.machine.role === "viewer" ? (
        <Text className="shrink-0 text-2xs font-ryco-medium text-foreground-tertiary">
          {" "}
          · Viewer
        </Text>
      ) : null}
      {/* Mandatory §13.1 label, one vocabulary across every surface. */}
      {props.machine.trust === "unverified" ? (
        <Text className="shrink-0 text-2xs font-ryco-medium text-danger-foreground">
          {" "}
          · {NODE_TRUST_UNVERIFIED_LABEL}
        </Text>
      ) : null}
      {props.machine.trust === "account-trusted" ? (
        <Text className="shrink-0 text-2xs font-ryco-medium text-foreground-tertiary">
          {" "}
          · {NODE_TRUST_ACCOUNT_LABEL}
        </Text>
      ) : null}
    </View>
  );
}

function ProjectRow(props: { readonly row: ProjectListRow; readonly onPress?: () => void }) {
  const iconColor = useThemeColor("--color-icon-muted");
  const content = (
    <>
      <View className="h-10 w-10 items-center justify-center rounded-xl bg-subtle">
        <SymbolView
          name="folder.fill"
          size={20}
          tintColor={iconColor as string}
          type="monochrome"
        />
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <Text className="font-ryco-medium text-[17px] text-foreground" numberOfLines={1}>
          {props.row.title}
        </Text>
        <Text className="font-mono text-2xs text-foreground-muted" numberOfLines={1}>
          {props.row.path}
        </Text>
        <Text className="text-xs font-ryco-medium text-foreground-tertiary">
          {props.row.worktreeCount} worktree{props.row.worktreeCount === 1 ? "" : "s"} ·{" "}
          {props.row.activeThreadCount} active
        </Text>
        {props.row.machines.map((machine) => (
          <MachineProvenance
            key={`${machine.environmentId}:${machine.projectId}`}
            machine={machine}
          />
        ))}
      </View>
      {props.onPress ? (
        <SymbolView
          name="chevron.right"
          size={15}
          tintColor={iconColor as string}
          type="monochrome"
        />
      ) : null}
    </>
  );

  if (!props.onPress) {
    return (
      <View className="mx-4 mb-2.5 flex-row items-center gap-3 rounded-2xl bg-card px-4 py-3.5">
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={projectRowAccessibilityLabel(props.row)}
      onPress={props.onPress}
      className="mx-4 mb-2.5 flex-row items-center gap-3 rounded-2xl bg-card px-4 py-3.5 active:bg-card-alt"
    >
      {content}
    </Pressable>
  );
}

export function ProjectsScreen(props: {
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
      data={props.rows}
      renderItem={renderItem}
      keyExtractor={(item) => item.key}
      recycleItems
      maintainVisibleContentPosition
      initialScrollOffset={props.initialScrollOffset}
      onScroll={(event) => props.onScrollOffset?.(event.nativeEvent.contentOffset.y)}
      scrollEventThrottle={32}
      contentInsetAdjustmentBehavior="never"
      contentContainerStyle={{ paddingBottom: HOME_LIST_PADDING_BOTTOM }}
      ListHeaderComponent={
        props.hasMachines && props.rows.length > 0 ? (
          <View className="px-4 pt-4 pb-1">
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
