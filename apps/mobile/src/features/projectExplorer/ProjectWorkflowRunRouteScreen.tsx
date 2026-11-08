import { type StaticScreenProps } from "@react-navigation/native";
import { describeWorkflowRerunError } from "@ryco/client-runtime/state/pull-request-review";
import type { EnvironmentId } from "@ryco/contracts";
import { WS_METHODS } from "@ryco/contracts/rpc";
import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Modal, Pressable, RefreshControl, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { LoadingStrip } from "../../components/LoadingStrip";
import { cn } from "../../lib/cn";
import { openWebLink } from "../../lib/openWebLink";
import { refreshProjectExplorerReads } from "../../rpc/projectExplorerAtoms";
import { CheckDot, SectionTitle } from "../pullRequests/PullRequestParts";
import { usePullRequestCheckout } from "../pullRequests/usePullRequestData";
import { WorkflowRunSummary } from "./ActionsTab";
import { explorerScopeFromParams, parseRunIdParam } from "./projectExplorerModel";
import { CardButton, ProblemState } from "./ProjectExplorerParts";
import { useExplorerChange } from "./useExplorerChange";
import { useExplorerNavigation } from "./useExplorerNavigation";
import { useWorkflowJobLog, useWorkflowRun } from "./useProjectExplorerData";
import {
  buildWorkflowRerunInput,
  canRerunFailedJobs,
  deriveWorkflowLog,
  workflowJobRows,
  workflowRerunNotice,
  workflowRerunTargetKey,
  workflowRunRow,
  type WorkflowJobRow,
  type WorkflowLogLine,
  type WorkflowLogLineTone,
  type WorkflowRerunTarget,
} from "./workflowRunsModel";

type ProjectWorkflowRunRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId: string;
  readonly runId: string;
}>;

const LOG_TONE: Readonly<Record<WorkflowLogLineTone, string>> = {
  plain: "text-foreground-secondary",
  group: "font-ryco-bold text-foreground",
  error: "text-danger-foreground",
  warning: "text-warning",
  muted: "text-foreground-tertiary",
};

function LogLine(props: { readonly line: WorkflowLogLine }) {
  return (
    <Text
      selectable
      className={cn("px-4 font-mono text-2xs leading-relaxed", LOG_TONE[props.line.tone])}
    >
      {props.line.text.length > 0 ? props.line.text : " "}
    </Text>
  );
}

/** One job's log, in a page sheet: the host's lines without their timestamps. */
function JobLogSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly runId: string;
  readonly job: WorkflowJobRow | null;
  readonly onClose: () => void;
}) {
  const { job } = props;
  const { log, problem } = useWorkflowJobLog({
    environmentId: props.environmentId,
    cwd: props.cwd,
    runId: props.runId,
    jobId: job === null ? null : job.jobId,
  });
  const data = log.data;
  const view = useMemo(() => (data === null ? null : deriveWorkflowLog(data)), [data]);
  const listRef = useRef<FlatList<WorkflowLogLine>>(null);
  const firstError = view === null ? null : view.firstErrorIndex;
  const jumpToError = () => {
    if (firstError !== null)
      listRef.current?.scrollToIndex({ index: firstError, viewPosition: 0.2 });
  };
  return (
    <Modal
      visible={job !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <View className="flex-1 bg-screen">
        <View className="flex-row items-center gap-3 px-5 pb-2 pt-5">
          <Text className="min-w-0 flex-1 text-lg font-ryco-bold text-foreground" numberOfLines={1}>
            {job === null ? "" : job.name}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={props.onClose}
            className="h-11 min-w-11 items-center justify-center rounded-full px-2 active:bg-subtle"
          >
            <Text className="text-base font-ryco-bold text-primary">Done</Text>
          </Pressable>
        </View>
        {log.isLoading ? <LoadingStrip /> : null}
        {view !== null && (view.truncated || firstError !== null) ? (
          <View className="flex-row items-center gap-3 px-5 pb-2">
            {view.truncated ? (
              <Text className="min-w-0 flex-1 text-xs text-warning">
                Only the end of a long log was sent.
              </Text>
            ) : (
              <View className="flex-1" />
            )}
            {firstError !== null ? (
              <Pressable
                accessibilityRole="button"
                onPress={jumpToError}
                className="active:opacity-70"
              >
                <Text className="text-xs font-ryco-bold text-danger-foreground">First error</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        <FlatList<WorkflowLogLine>
          ref={listRef}
          className="flex-1"
          data={view === null ? [] : view.lines}
          keyExtractor={(line) => line.key}
          renderItem={({ item }) => <LogLine line={item} />}
          initialNumToRender={60}
          windowSize={11}
          onScrollToIndexFailed={(info) =>
            listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index })
          }
          ListEmptyComponent={
            problem !== null ? (
              <ProblemState problem={problem} />
            ) : view !== null ? (
              <Text className="px-5 py-6 text-sm text-foreground-muted">
                The host returned no log output for this job.
              </Text>
            ) : null
          }
          contentContainerStyle={{ paddingBottom: 48 }}
        />
      </View>
    </Modal>
  );
}

function JobCard(props: {
  readonly job: WorkflowJobRow;
  readonly expanded: boolean;
  readonly rerunOffered: boolean;
  readonly rerunDisabled: boolean;
  readonly rerunning: boolean;
  readonly onToggle: () => void;
  readonly onLog: () => void;
  readonly onRerun: () => void;
}) {
  const { job } = props;
  return (
    <View className="mx-4 mb-2 rounded-2xl border border-border bg-card">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: props.expanded }}
        accessibilityLabel={`${job.name}: ${job.status.label}`}
        onPress={props.onToggle}
        className="flex-row items-center gap-3 px-4 py-3 active:opacity-70"
      >
        <CheckDot overall={job.status.overall} showNone />
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-ryco-medium text-foreground" numberOfLines={2}>
            {job.name}
          </Text>
          <Text className="text-2xs text-foreground-muted">
            {job.status.label}
            {job.duration ? ` · ${job.duration}` : ""}
          </Text>
        </View>
      </Pressable>
      {props.expanded ? (
        <View className="gap-2 border-t border-border-subtle px-4 pb-3 pt-2">
          {job.steps.map((step) => (
            <View key={step.key} className="flex-row items-center gap-2.5">
              <CheckDot overall={step.status.overall} showNone />
              <Text className="min-w-0 flex-1 text-xs text-foreground" numberOfLines={2}>
                {step.name}
              </Text>
              {step.duration ? (
                <Text className="font-mono text-2xs text-foreground-tertiary">{step.duration}</Text>
              ) : null}
            </View>
          ))}
          <View className="mt-1 flex-row gap-2">
            <CardButton label="Log" symbol="doc.text" onPress={props.onLog} />
            {job.canRerun && props.rerunOffered ? (
              <CardButton
                label={props.rerunning ? "Re-running…" : "Re-run"}
                symbol="arrow.clockwise"
                disabled={props.rerunDisabled}
                onPress={props.onRerun}
              />
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** One workflow run: what it ran on, its jobs and steps, their logs, and re-runs of what failed. */
export function ProjectWorkflowRunRouteScreen(props: ProjectWorkflowRunRouteProps) {
  const { environmentId, projectId } = explorerScopeFromParams(props.route.params);
  const runId = parseRunIdParam(props.route.params.runId);
  const checkout = usePullRequestCheckout(environmentId, projectId);
  const cwd = checkout.cwd;
  const data = useWorkflowRun({ environmentId, cwd, runId });
  const { run, jobs } = data;
  const runRow = useMemo(() => (run === null ? null : workflowRunRow(run)), [run]);
  const jobList = jobs.data?.jobs ?? null;
  const jobRows = useMemo(() => (jobList === null ? [] : workflowJobRows(jobList)), [jobList]);
  const { navigation } = useExplorerNavigation(environmentId, projectId);
  const change = useExplorerChange(environmentId);
  const rerunOffer = change.offer(WS_METHODS.sourceControlRerunWorkflow);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [logJob, setLogJob] = useState<WorkflowJobRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const workflowName = runRow === null ? null : runRow.workflowName;

  useEffect(() => {
    navigation.setOptions({ title: workflowName ?? "Workflow run" });
  }, [navigation, workflowName]);

  if (environmentId === null || projectId === null || runId === null || cwd === null) {
    return (
      <View className="flex-1 bg-screen px-5 py-16">
        <EmptyState
          variant="plain"
          title="Workflow run unavailable"
          detail="The selected node has not published this project yet."
        />
      </View>
    );
  }

  const toggle = (jobId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });

  const rerun = (target: WorkflowRerunTarget) => {
    setNotice(null);
    change.run({
      kind: workflowRerunTargetKey(target),
      failure: "The re-run was not requested.",
      perform: (client) =>
        client.sourceControl.rerunWorkflow(buildWorkflowRerunInput(cwd, runId, target)),
      onDone: () => {
        setNotice(workflowRerunNotice(target));
        refreshProjectExplorerReads({ environmentId, scope: cwd, family: "runs" });
      },
      describeFailure: (cause) => describeWorkflowRerunError(cause).message,
    });
  };

  const busy = change.pending !== null;
  const rerunDisabled = busy || rerunOffer.blockedReason !== null;

  const listHeader = (
    <View className="gap-3 pb-1 pt-3">
      {runRow !== null ? (
        <View className="mx-4 gap-1.5 rounded-[22px] border border-border bg-card p-4">
          <WorkflowRunSummary row={runRow} />
          {runRow.actor || runRow.event ? (
            <Text className="text-xs text-foreground-tertiary" numberOfLines={1}>
              {[runRow.event, runRow.actor ? `by @${runRow.actor}` : null]
                .filter((part) => part !== null)
                .join(" · ")}
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="link"
            onPress={() => openWebLink(runRow.url)}
            className="mt-1 self-start active:opacity-70"
          >
            <Text className="text-sm font-ryco-bold text-primary">Open on {runRow.hostName}</Text>
          </Pressable>
        </View>
      ) : null}
      {canRerunFailedJobs(run) && rerunOffer.offered ? (
        <View className="flex-row px-4">
          <CardButton
            label={change.pending === "failed-jobs" ? "Re-running…" : "Re-run failed jobs"}
            symbol="arrow.clockwise"
            primary
            disabled={rerunDisabled}
            onPress={() => rerun({ target: "failed-jobs" })}
          />
        </View>
      ) : null}
      {rerunOffer.offered && rerunOffer.blockedReason ? (
        <Text className="px-5 text-xs text-foreground-muted">{rerunOffer.blockedReason}</Text>
      ) : null}
      {notice ? <Text className="px-5 text-sm font-ryco-medium text-success">{notice}</Text> : null}
      {change.error ? (
        <View className="px-4">
          <ErrorBanner message={change.error} />
        </View>
      ) : null}
      {jobs.isLoading ? <LoadingStrip /> : null}
      {jobRows.length > 0 ? <SectionTitle title="Jobs" detail={String(jobRows.length)} /> : null}
    </View>
  );

  return (
    <>
      <FlatList<WorkflowJobRow>
        className="flex-1 bg-screen"
        contentInsetAdjustmentBehavior="automatic"
        data={jobRows}
        keyExtractor={(job) => job.jobId}
        ListHeaderComponent={listHeader}
        renderItem={({ item }) => (
          <JobCard
            job={item}
            expanded={expanded.has(item.jobId)}
            rerunOffered={rerunOffer.offered}
            rerunDisabled={rerunDisabled}
            rerunning={change.pending === `job:${item.jobId}`}
            onToggle={() => toggle(item.jobId)}
            onLog={() => setLogJob(item)}
            onRerun={() => rerun({ target: "job", jobId: item.jobId, jobName: item.name })}
          />
        )}
        ListEmptyComponent={
          data.problem !== null ? (
            <ProblemState problem={data.problem} />
          ) : jobs.data !== null ? (
            <Text className="px-5 py-4 text-sm text-foreground-muted">
              This run has no jobs yet.
            </Text>
          ) : null
        }
        refreshControl={<RefreshControl refreshing={data.refreshing} onRefresh={data.refresh} />}
        contentContainerStyle={{ paddingBottom: 48 }}
      />
      <JobLogSheet
        environmentId={environmentId}
        cwd={cwd}
        runId={runId}
        job={logJob}
        onClose={() => setLogJob(null)}
      />
    </>
  );
}
