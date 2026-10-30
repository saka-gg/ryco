import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { relativePathToRouteSegments } from "@ryco/client-runtime/state/files";
import { resolveChangeRequestPresentationForKind } from "@ryco/shared/sourceControl";
import { EnvironmentId, ProjectId } from "@ryco/contracts/base-schemas";
import { useEffect, useState } from "react";
import { FlatList, Pressable, RefreshControl, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { LoadingStrip } from "../../components/LoadingStrip";
import { cn } from "../../lib/cn";
import { openWebLink } from "../../lib/openWebLink";
import {
  derivePullRequestDetailItems,
  derivePullRequestHeader,
  describePullRequestNextStep,
  parsePullRequestNumberParam,
  PULL_REQUEST_DETAIL_TABS,
  type PullRequestCheckRow,
  type PullRequestConversationRow,
  type PullRequestDetailItem,
  type PullRequestDetailTab,
  type PullRequestFileRow,
  type PullRequestHeader,
  type PullRequestNextStep,
  type PullRequestThreadModel,
} from "./pullRequestDetailModel";
import {
  ActorLine,
  CheckDot,
  ChipRow,
  FilterChip,
  PullRequestMarkdown,
  PullRequestStatePill,
  SectionTitle,
} from "./PullRequestParts";
import {
  usePullRequest,
  usePullRequestCheckout,
  usePullRequestDiff,
  useSourceControlProvider,
} from "./usePullRequestData";

type PullRequestRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId: string;
  readonly number: string;
}>;

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

const NEXT_STEP_TONE: Readonly<Record<PullRequestNextStep["tone"], string>> = {
  neutral: "border-border bg-card",
  success: "border-success-border bg-success-bg",
  warning: "border-warning-border bg-warning-bg",
  danger: "border-danger-border bg-danger",
  progress: "border-accent-border bg-accent-bg",
};

function Header(props: {
  readonly header: PullRequestHeader;
  readonly nextStep: PullRequestNextStep | null;
  readonly hostName: string;
}) {
  const { header } = props;
  return (
    <View className="gap-3 px-4 pt-3">
      <View className="gap-2 rounded-[22px] border border-border bg-card p-4">
        <View className="flex-row items-center gap-2">
          <PullRequestStatePill tone={header.stateTone} label={header.stateLabel} />
          <Text className="font-mono text-xs text-foreground-muted">#{header.number}</Text>
          {header.changeSummary ? (
            <Text className="ml-auto font-mono text-2xs text-foreground-tertiary">
              {header.changeSummary}
            </Text>
          ) : null}
        </View>
        <Text className="text-lg font-ryco-bold text-foreground" selectable>
          {header.title}
        </Text>
        <Text className="text-xs text-foreground-muted" numberOfLines={2}>
          {header.author ? (
            <Text className="font-ryco-bold text-foreground">@{header.author}</Text>
          ) : null}
          {header.author ? " wants to merge " : "Merging "}
          <Text className="font-mono">{header.headRefName}</Text>
          {" into "}
          <Text className="font-mono">{header.baseRefName}</Text>
        </Text>
        {header.labels.length > 0 ? (
          <View className="flex-row flex-wrap gap-1.5">
            {header.labels.map((label) => (
              <View key={label.name} className="rounded-full bg-subtle px-2 py-0.5">
                <Text className="text-2xs font-ryco-medium text-foreground-secondary">
                  {label.name}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
        {header.url ? (
          <Pressable
            accessibilityRole="link"
            onPress={() => openWebLink(header.url)}
            className="self-start active:opacity-70"
          >
            <Text className="text-sm font-ryco-bold text-primary">Open on {props.hostName}</Text>
          </Pressable>
        ) : null}
      </View>
      {props.nextStep ? (
        <View className={cn("rounded-2xl border px-4 py-3", NEXT_STEP_TONE[props.nextStep.tone])}>
          <Text className="text-sm font-ryco-bold text-foreground">{props.nextStep.label}</Text>
          {props.nextStep.reason ? (
            <Text className="mt-0.5 text-xs text-foreground-muted">{props.nextStep.reason}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function ThreadBlock(props: { readonly thread: PullRequestThreadModel }) {
  const { thread } = props;
  return (
    <View className="mt-2 gap-2 rounded-xl border border-border-subtle bg-card-alt p-3">
      <View className="flex-row items-center gap-2">
        <Text className="min-w-0 flex-1 font-mono text-2xs text-foreground-muted" numberOfLines={1}>
          {thread.location}
        </Text>
        {thread.resolved ? <Text className="text-2xs text-success">Resolved</Text> : null}
        {thread.outdated ? (
          <Text className="text-2xs text-foreground-tertiary">Outdated</Text>
        ) : null}
      </View>
      {thread.comments.map((comment) => (
        <View key={comment.id} className="gap-1">
          <ActorLine author={comment.author} atMs={comment.atMs} />
          <PullRequestMarkdown markdown={comment.body} />
        </View>
      ))}
      {thread.moreComments > 0 ? (
        <Text className="text-2xs text-foreground-tertiary">
          {thread.moreComments} more {thread.moreComments === 1 ? "reply" : "replies"} on the host
        </Text>
      ) : null}
    </View>
  );
}

function ConversationRow(props: { readonly row: PullRequestConversationRow }) {
  const { row } = props;
  switch (row.kind) {
    case "comment":
      return (
        <View className="mx-4 mb-2 gap-1.5 rounded-2xl border border-border bg-card px-4 py-3">
          <ActorLine author={row.author} atMs={row.atMs}>
            commented
          </ActorLine>
          <PullRequestMarkdown markdown={row.body} />
        </View>
      );
    case "review":
      return (
        <View className="mx-4 mb-2 rounded-2xl border border-border bg-card px-4 py-3">
          <ActorLine author={row.author} atMs={row.atMs}>
            <Text
              className={cn(
                row.verdict === "approved" && "text-success",
                row.verdict === "changes-requested" && "text-warning",
              )}
            >
              {row.text}
            </Text>
          </ActorLine>
          {row.body ? (
            <View className="mt-1.5">
              <PullRequestMarkdown markdown={row.body} />
            </View>
          ) : null}
          {row.threads.map((thread) => (
            <ThreadBlock key={thread.id} thread={thread} />
          ))}
        </View>
      );
    case "commits":
      return (
        <View className="mx-4 mb-2 px-1 py-1">
          <ActorLine author={row.author} atMs={row.atMs}>
            {row.text}
          </ActorLine>
          {row.commits.map((commit) => (
            <View key={commit.oid} className="mt-1 flex-row items-center gap-2 pl-2">
              <CheckDot overall={commit.checks ?? "none"} />
              <Text className="font-mono text-2xs text-foreground-tertiary">{commit.shortOid}</Text>
              <Text className="min-w-0 flex-1 text-xs text-foreground" numberOfLines={1}>
                {commit.headline}
              </Text>
            </View>
          ))}
        </View>
      );
    case "event":
      return (
        <View className="mx-4 mb-2 px-1 py-1">
          <ActorLine author={row.author} atMs={row.atMs}>
            {row.text}
          </ActorLine>
        </View>
      );
    case "thread":
      return (
        <View className="mx-4 mb-2 rounded-2xl border border-border bg-card px-4 py-3">
          <ActorLine author={row.author} atMs={row.atMs}>
            commented on a line
          </ActorLine>
          <ThreadBlock thread={row.thread} />
        </View>
      );
  }
}

function CheckRow(props: { readonly row: PullRequestCheckRow }) {
  const { row } = props;
  return (
    <Pressable
      accessibilityRole={row.url ? "link" : undefined}
      disabled={row.url === null}
      onPress={() => openWebLink(row.url)}
      className="mx-4 mb-1.5 flex-row items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-2.5 active:bg-card-alt"
    >
      <CheckDot overall={row.overall} showNone />
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-ryco-medium text-foreground" numberOfLines={1}>
          {row.label}
        </Text>
        <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
          {row.stateLabel}
          {row.duration ? ` · ${row.duration}` : ""}
          {row.required ? " · Required" : ""}
          {row.workflowName && row.workflowName !== row.label ? ` · ${row.workflowName}` : ""}
        </Text>
      </View>
    </Pressable>
  );
}

function FileRow(props: {
  readonly row: PullRequestFileRow;
  readonly onPress: (path: string) => void;
}) {
  const { row } = props;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => props.onPress(row.path)}
      className="mx-4 mb-1.5 flex-row items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-2.5 active:bg-card-alt"
    >
      <Text className="w-4 text-center font-mono text-xs font-ryco-bold text-foreground-muted">
        {row.statusLetter ?? "·"}
      </Text>
      <View className="min-w-0 flex-1">
        <Text className="font-mono text-xs text-foreground" numberOfLines={2}>
          {row.path}
        </Text>
        {row.previousPath ? (
          <Text className="font-mono text-2xs text-foreground-tertiary" numberOfLines={1}>
            from {row.previousPath}
          </Text>
        ) : null}
      </View>
      <Text className="font-mono text-2xs text-foreground-tertiary">
        {row.binary ? "binary" : row.diffStat}
      </Text>
    </Pressable>
  );
}

/** One pull request: header, conversation, checks and files, read-only. */
export function PullRequestRouteScreen(props: PullRequestRouteProps) {
  const navigation = useNavigation();
  const environmentIdRaw = firstParam(props.route.params.environmentId);
  const projectIdRaw = firstParam(props.route.params.projectId);
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const projectId = projectIdRaw ? ProjectId.make(projectIdRaw) : null;
  const number = parsePullRequestNumberParam(props.route.params.number);
  const checkout = usePullRequestCheckout(environmentId, projectId);
  const provider = useSourceControlProvider(environmentId, checkout.cwd);
  const pullRequest = usePullRequest({ environmentId, cwd: checkout.cwd, number, provider });
  const [tab, setTab] = useState<PullRequestDetailTab>("conversation");
  const diff = usePullRequestDiff({
    environmentId,
    cwd: checkout.cwd,
    number,
    detail: pullRequest.detail.data,
    enabled: tab === "files" && pullRequest.capabilities.diff,
  });

  useEffect(() => {
    if (number !== null) navigation.setOptions({ title: `#${number}` });
  }, [navigation, number]);

  if (environmentId === null || projectId === null || number === null || checkout.cwd === null) {
    return (
      <View className="flex-1 bg-screen px-5 py-16">
        <EmptyState
          variant="plain"
          title="Pull request unavailable"
          detail="The selected node has not published this checkout yet."
        />
      </View>
    );
  }

  const detail = pullRequest.detail.data;
  const header = derivePullRequestHeader(detail, null);
  const hostName = resolveChangeRequestPresentationForKind(
    detail?.provider ?? "github",
  ).providerName;

  const openFile = (path: string) =>
    navigation.navigate("ProjectPullRequestFile", {
      environmentId,
      projectId,
      number: String(number),
      path: [...relativePathToRouteSegments(path)],
    });

  const items = derivePullRequestDetailItems({
    tab,
    header,
    hostName,
    detail,
    activity: pullRequest.activity.data,
    activitySupported: pullRequest.capabilities.activity,
    hostKnown: provider !== null,
    checks: pullRequest.checks,
    diff,
  });

  const loadError = pullRequest.detail.error?.message ?? null;
  const refreshing =
    (pullRequest.detail.isFetching && detail !== null) ||
    (pullRequest.activity.isFetching && pullRequest.activity.data !== null);

  const listHeader = (
    <View className="gap-3 pb-2">
      {header ? (
        <Header
          header={header}
          nextStep={describePullRequestNextStep(pullRequest.nextAction)}
          hostName={hostName}
        />
      ) : null}
      {loadError && detail === null ? (
        <View className="px-4 pt-3">
          <ErrorBanner message={loadError} />
        </View>
      ) : null}
      <ChipRow>
        {PULL_REQUEST_DETAIL_TABS.map((option) => (
          <FilterChip
            key={option.value}
            label={
              option.value === "checks" && pullRequest.checks.checks.length > 0
                ? `${option.label} ${pullRequest.checks.checks.length}`
                : option.label
            }
            selected={tab === option.value}
            onPress={() => setTab(option.value)}
          />
        ))}
      </ChipRow>
      {pullRequest.detail.isLoading ||
      (tab === "conversation" && pullRequest.activity.isLoading) ||
      (tab === "files" && diff.status === "loading") ? (
        <LoadingStrip />
      ) : null}
    </View>
  );

  return (
    <FlatList<PullRequestDetailItem>
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      data={items}
      keyExtractor={(item) => item.key}
      ListHeaderComponent={listHeader}
      renderItem={({ item }) => {
        switch (item.kind) {
          case "section":
            return <SectionTitle title={item.title} detail={item.detail} />;
          case "description":
            return (
              <View className="mx-4 mb-3 rounded-2xl border border-border bg-card px-4 py-3">
                <PullRequestMarkdown markdown={item.body} />
              </View>
            );
          case "conversation":
            return <ConversationRow row={item.row} />;
          case "check":
            return <CheckRow row={item.row} />;
          case "file":
            return <FileRow row={item.row} onPress={openFile} />;
          case "note":
            return <Text className="px-5 pb-2 text-xs text-foreground-muted">{item.text}</Text>;
        }
      }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            pullRequest.refresh();
            if (tab === "files") diff.refresh();
          }}
        />
      }
      contentContainerStyle={{ paddingBottom: 48 }}
    />
  );
}
