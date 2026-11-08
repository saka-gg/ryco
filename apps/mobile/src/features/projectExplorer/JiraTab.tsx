import type { EnvironmentId, ProjectId, WorkItemStateFilter } from "@ryco/contracts";
import { useState, type ReactElement } from "react";
import { FlatList, Pressable, RefreshControl, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { LoadingStrip } from "../../components/LoadingStrip";
import { relativeTime } from "../../lib/time";
import { ChipRow, FilterChip } from "../pullRequests/PullRequestParts";
import { PlainNote, ProblemState, SearchField, WorkItemStatePill } from "./ProjectExplorerParts";
import { useExplorerNavigation } from "./useExplorerNavigation";
import { useJiraLink, useWorkItemList } from "./useProjectExplorerData";
import { WORK_ITEM_STATE_OPTIONS, type WorkItemRow } from "./workItemsModel";

function WorkItemListRow(props: {
  readonly row: WorkItemRow;
  readonly onPress: (key: string) => void;
}) {
  const { row } = props;
  const time =
    row.updatedAtMs === null ? null : relativeTime(new Date(row.updatedAtMs).toISOString());
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${row.key}: ${row.title}. ${row.stateLabel}.`}
      onPress={() => props.onPress(row.key)}
      className="mx-4 mb-2 gap-1.5 rounded-2xl border border-border bg-card px-4 py-3 active:bg-card-alt"
    >
      <View className="flex-row items-start gap-2">
        <Text
          className="min-w-0 flex-1 text-base font-ryco-medium text-foreground"
          numberOfLines={2}
        >
          {row.title}
        </Text>
        {time ? <Text className="pt-0.5 text-xs text-foreground-tertiary">{time}</Text> : null}
      </View>
      <View className="flex-row items-center gap-2">
        <Text className="font-mono text-xs text-foreground-muted">{row.key}</Text>
        <WorkItemStatePill tone={row.tone} label={row.stateLabel} />
        {row.issueType ? (
          <Text className="shrink text-xs text-foreground-tertiary" numberOfLines={1}>
            {row.issueType}
          </Text>
        ) : null}
        {row.assignee ? (
          <Text className="ml-auto shrink text-xs text-foreground-tertiary" numberOfLines={1}>
            {row.assignee}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function WorkItemList(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly header: ReactElement;
}) {
  const [state, setState] = useState<WorkItemStateFilter>("open");
  const [query, setQuery] = useState("");
  const list = useWorkItemList({
    environmentId: props.environmentId,
    projectId: props.projectId,
    state,
    query,
    enabled: true,
  });
  const explorer = useExplorerNavigation(props.environmentId, props.projectId);
  const searching = query.trim().length > 0;
  const header = (
    <View className="gap-2.5 pb-2 pt-2">
      {props.header}
      <SearchField value={query} onChange={setQuery} placeholder="Search work items" />
      <ChipRow>
        {WORK_ITEM_STATE_OPTIONS.map((option) => (
          <FilterChip
            key={option.value}
            label={option.label}
            selected={state === option.value}
            onPress={() => setState(option.value)}
          />
        ))}
      </ChipRow>
      {list.loading ? <LoadingStrip /> : null}
      {list.problem !== null && list.rows.length > 0 ? (
        <View className="px-4">
          <ErrorBanner message={list.problem.detail} />
        </View>
      ) : null}
    </View>
  );
  return (
    <FlatList<WorkItemRow>
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      data={list.rows}
      keyExtractor={(row) => row.key}
      ListHeaderComponent={header}
      renderItem={({ item }) => <WorkItemListRow row={item} onPress={explorer.openWorkItem} />}
      ListEmptyComponent={
        list.problem !== null ? (
          <ProblemState problem={list.problem} />
        ) : list.loading ? null : (
          <PlainNote
            title={searching ? "No matching work items" : "No work items"}
            detail={
              searching
                ? "No work item's key, title or type matches this search."
                : "Nothing in the linked Jira projects is in this state."
            }
          />
        )
      }
      refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} />}
      contentContainerStyle={{ paddingBottom: 48 }}
    />
  );
}

/**
 * The project's Jira work items, when the project is linked to Jira; a quiet
 * note when it is not (linking happens on the desktop).
 */
export function JiraTab(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly header: ReactElement;
}) {
  const link = useJiraLink({ environmentId: props.environmentId, projectId: props.projectId });
  if (link.status === "linked") {
    return (
      <WorkItemList
        environmentId={props.environmentId}
        projectId={props.projectId}
        header={props.header}
      />
    );
  }
  return (
    <FlatList<never>
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      data={[]}
      renderItem={() => null}
      ListHeaderComponent={
        <View className="gap-2.5 pb-2 pt-2">
          {props.header}
          {link.status === "loading" ? <LoadingStrip /> : null}
        </View>
      }
      ListEmptyComponent={
        link.status === "problem" && link.problem !== null ? (
          <ProblemState problem={link.problem} />
        ) : link.status === "unlinked" ? (
          <PlainNote
            title="No Jira project linked"
            detail="Link this project to Jira in Ryco on your computer to see its work items here."
          />
        ) : null
      }
      refreshControl={<RefreshControl refreshing={false} onRefresh={link.refresh} />}
      contentContainerStyle={{ paddingBottom: 48 }}
    />
  );
}
