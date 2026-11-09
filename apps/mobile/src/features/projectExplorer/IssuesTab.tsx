import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { useState, type ReactElement } from "react";
import { FlatList, Pressable, RefreshControl, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { LoadingStrip } from "../../components/LoadingStrip";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { useThemeColor } from "../../lib/useThemeColor";
import { ChipRow, FilterChip } from "../pullRequests/PullRequestParts";
import { ISSUE_STATE_OPTIONS, type IssueListRow, type IssueStateFilter } from "./issuesModel";
import { LabelRow, PlainNote, ProblemState, SearchField } from "./ProjectExplorerParts";
import { useExplorerNavigation } from "./useExplorerNavigation";
import { useIssueList } from "./useProjectExplorerData";

function timeLabel(atMs: number | null): string | null {
  return atMs === null ? null : relativeTime(new Date(atMs).toISOString());
}

function IssueRow(props: {
  readonly row: IssueListRow;
  readonly onPress: (number: number) => void;
}) {
  const { row } = props;
  const iconColor = useThemeColor("--color-icon-subtle");
  const time = timeLabel(row.updatedAtMs);
  const open = row.state === "open";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Issue ${row.number}: ${row.title}. ${open ? "Open" : "Closed"}.`}
      onPress={() => props.onPress(row.number)}
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
        <View
          className={cn("h-2 w-2 rounded-full", open ? "bg-success" : "bg-violet-500")}
          accessible
          accessibilityLabel={open ? "Open" : "Closed"}
        />
        <Text className="font-mono text-xs text-foreground-muted">#{row.number}</Text>
        {row.author ? (
          <Text className="shrink text-xs text-foreground-tertiary" numberOfLines={1}>
            @{row.author}
          </Text>
        ) : null}
        {row.comments > 0 ? (
          <View className="ml-auto flex-row items-center gap-1">
            <SymbolView
              name="text.bubble"
              size={12}
              tintColor={iconColor as string}
              type="monochrome"
            />
            <Text className="font-mono text-2xs text-foreground-tertiary">{row.comments}</Text>
          </View>
        ) : null}
      </View>
      <LabelRow labels={row.labels} more={row.moreLabels} />
    </Pressable>
  );
}

/** One project's issues: open/closed/all, narrowed as the reader types. */
export function IssuesTab(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly cwd: string;
  readonly header: ReactElement;
}) {
  const [state, setState] = useState<IssueStateFilter>("open");
  const [query, setQuery] = useState("");
  const list = useIssueList({ environmentId: props.environmentId, cwd: props.cwd, state, query });
  const { screen } = list;
  const explorer = useExplorerNavigation(props.environmentId, props.projectId);
  const quietProblem = screen.problem !== null && screen.problem.kind !== "error";

  const header = (
    <View className="gap-2.5 pb-2 pt-2">
      {props.header}
      {quietProblem ? null : (
        <>
          <SearchField value={query} onChange={setQuery} placeholder="Search issues" />
          <ChipRow>
            {ISSUE_STATE_OPTIONS.map((option) => (
              <FilterChip
                key={option.value}
                label={option.label}
                selected={state === option.value}
                onPress={() => setState(option.value)}
              />
            ))}
          </ChipRow>
        </>
      )}
      {screen.status === "loading" ? <LoadingStrip /> : null}
      {screen.problem !== null && screen.status === "ready" ? (
        <View className="px-4">
          <ErrorBanner message={screen.problem.detail} />
        </View>
      ) : null}
    </View>
  );

  return (
    <FlatList<IssueListRow>
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      data={screen.rows}
      keyExtractor={(row) => row.key}
      ListHeaderComponent={header}
      renderItem={({ item }) => <IssueRow row={item} onPress={explorer.openIssue} />}
      ListEmptyComponent={
        screen.status === "problem" && screen.problem !== null ? (
          <ProblemState problem={screen.problem} />
        ) : screen.status === "empty" ? (
          <PlainNote title={screen.emptyTitle} detail={screen.emptyDetail} />
        ) : null
      }
      refreshControl={<RefreshControl refreshing={list.refreshing} onRefresh={list.refresh} />}
      contentContainerStyle={{ paddingBottom: 48 }}
    />
  );
}
