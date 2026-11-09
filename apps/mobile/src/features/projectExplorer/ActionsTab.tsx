import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import type { ReactElement } from "react";
import { FlatList, Pressable, RefreshControl, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { LoadingStrip } from "../../components/LoadingStrip";
import { relativeTime } from "../../lib/time";
import { CheckDot } from "../pullRequests/PullRequestParts";
import { PlainNote, ProblemState } from "./ProjectExplorerParts";
import { useExplorerNavigation } from "./useExplorerNavigation";
import { useWorkflowRuns } from "./useProjectExplorerData";
import type { WorkflowRunRow } from "./workflowRunsModel";

function timeLabel(atMs: number | null): string | null {
  return atMs === null ? null : relativeTime(new Date(atMs).toISOString());
}

/** One run: workflow, what it ran on, and how it went. */
export function WorkflowRunSummary(props: { readonly row: WorkflowRunRow }) {
  const { row } = props;
  const time = timeLabel(row.atMs);
  return (
    <>
      <View className="flex-row items-center gap-2">
        <CheckDot overall={row.status.overall} showNone />
        <Text
          className="min-w-0 flex-1 text-base font-ryco-medium text-foreground"
          numberOfLines={1}
        >
          {row.workflowName}
        </Text>
        {time ? <Text className="text-xs text-foreground-tertiary">{time}</Text> : null}
      </View>
      {row.title ? (
        <Text className="text-sm text-foreground-secondary" numberOfLines={2}>
          {row.title}
        </Text>
      ) : null}
      <View className="flex-row items-center gap-2">
        <Text className="text-xs font-ryco-bold text-foreground-muted">{row.status.label}</Text>
        {row.branch ? (
          <Text className="shrink font-mono text-xs text-foreground-muted" numberOfLines={1}>
            {row.branch}
          </Text>
        ) : null}
        <Text className="font-mono text-2xs text-foreground-tertiary">{row.shortSha}</Text>
        {row.duration ? (
          <Text className="ml-auto font-mono text-2xs text-foreground-tertiary">
            {row.duration}
          </Text>
        ) : null}
      </View>
    </>
  );
}

function RunRow(props: {
  readonly row: WorkflowRunRow;
  readonly onPress: (runId: string) => void;
}) {
  const { row } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${row.workflowName}: ${row.status.label}`}
      onPress={() => props.onPress(row.runId)}
      className="mx-4 mb-2 gap-1.5 rounded-2xl border border-border bg-card px-4 py-3 active:bg-card-alt"
    >
      <WorkflowRunSummary row={row} />
    </Pressable>
  );
}

/** The checkout's latest workflow runs, newest first; running ones refresh on their own. */
export function ActionsTab(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly cwd: string;
  readonly header: ReactElement;
}) {
  const runs = useWorkflowRuns({ environmentId: props.environmentId, cwd: props.cwd });
  const explorer = useExplorerNavigation(props.environmentId, props.projectId);
  const header = (
    <View className="gap-2.5 pb-2 pt-2">
      {props.header}
      {runs.loading ? <LoadingStrip /> : null}
      {runs.problem !== null && runs.rows.length > 0 ? (
        <View className="px-4">
          <ErrorBanner message={runs.problem.detail} />
        </View>
      ) : null}
    </View>
  );
  return (
    <FlatList<WorkflowRunRow>
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      data={runs.rows}
      keyExtractor={(row) => row.runId}
      ListHeaderComponent={header}
      renderItem={({ item }) => <RunRow row={item} onPress={explorer.openWorkflowRun} />}
      ListEmptyComponent={
        runs.problem !== null ? (
          <ProblemState problem={runs.problem} />
        ) : runs.loading ? null : (
          <PlainNote
            title="No workflow runs"
            detail="Runs show up here once the repository's workflows run."
          />
        )
      }
      refreshControl={<RefreshControl refreshing={runs.refreshing} onRefresh={runs.refresh} />}
      contentContainerStyle={{ paddingBottom: 48 }}
    />
  );
}
