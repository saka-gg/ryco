import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { relativePathToRouteSegments } from "@ryco/client-runtime/state/files";
import { resolveChangeRequestPresentationForKind } from "@ryco/shared/sourceControl";
import { EnvironmentId, ProjectId } from "@ryco/contracts/base-schemas";
import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import {
  reviewDraftKey,
  splitFilePath,
  type ViewedFileState,
} from "@ryco/client-runtime/state/pull-request-review";
import * as Haptics from "expo-haptics";
import { useEffect, useState } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { LoadingStrip } from "../../components/LoadingStrip";
import { cn } from "../../lib/cn";
import { openWebLink } from "../../lib/openWebLink";
import { useThemeColor } from "../../lib/useThemeColor";
import { selectProjectByRef, useStore } from "../../state/threadsRuntime";
import { PULL_REQUEST_ACTION_BAR_HEIGHT, PullRequestActionBar } from "./PullRequestActionBar";
import {
  derivePullRequestReviewProgress,
  type PullRequestReviewProgress,
} from "./pullRequestFileReviewModel";
import { usePullRequestReviewDrafts } from "./pullRequestReviewDrafts";
import { usePullRequestFilesViewed } from "./usePullRequestFilesViewed";
import { PullRequestEditSheets, type PullRequestEditSheet } from "./PullRequestEditSheets";
import { PullRequestPeopleCard } from "./PullRequestPeopleCard";
import { derivePullRequestReviewers } from "./pullRequestPeopleModel";
import { usePullRequestLiveChecks } from "./usePullRequestLiveChecks";
import { PullRequestCheckRing } from "./PullRequestCheckRing";
import { describeCheckCounts, shortCheckCounts } from "./pullRequestCheckRingModel";
import { PULL_REQUEST_STACK_SYMBOL, pullRequestStateGlyph } from "./pullRequestGlyphModel";
import { pullRequestCheckCounts, type PullRequestCheckCounts } from "./pullRequestListModel";
import {
  PullRequestDiffStats,
  PullRequestStateIcon,
  usePullRequestToneColor,
} from "./PullRequestPresentation";
import {
  derivePullRequestStackNavigator,
  type PullRequestStackNavigatorModel,
} from "./pullRequestStackModel";
import {
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
import { useHomeEnvironments } from "../home/useHomeEnvironments";
import { ActorLine, CheckDot, PullRequestMarkdown, SectionTitle } from "./PullRequestParts";
import { usePullRequestActions } from "./usePullRequestActions";
import {
  usePullRequest,
  usePullRequestCheckout,
  usePullRequestDetailItems,
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
  readonly repository: string | null;
  readonly nextStep: PullRequestNextStep | null;
  readonly hostName: string;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly changedFiles: number | null;
  readonly onEdit: (() => void) | null;
}) {
  const { header } = props;
  const glyph = pullRequestStateGlyph({
    state:
      header.stateTone === "merged" ? "merged" : header.stateTone === "closed" ? "closed" : "open",
    isDraft: header.stateTone === "draft",
  });
  const toneColor = usePullRequestToneColor(glyph.tone);
  const editIconColor = useThemeColor("--color-icon") as string;
  return (
    <View className="gap-2.5 px-4 pt-2">
      <View className="flex-row items-center gap-2">
        {props.repository ? (
          <Text className="min-w-0 shrink text-xs text-foreground-muted" numberOfLines={1}>
            {props.repository}
          </Text>
        ) : null}
        <Text className="font-mono text-xs text-foreground-tertiary">#{header.number}</Text>
        <View className="flex-1" />
        <View
          className="flex-row items-center gap-1 rounded-full px-2.5 py-1"
          style={{ backgroundColor: `${toneColor}22` }}
        >
          <SymbolView name={glyph.symbol as never} size={12} tintColor={toneColor} />
          <Text className="text-2xs font-ryco-bold" style={{ color: toneColor }}>
            {header.stateLabel}
          </Text>
        </View>
      </View>
      <View className="flex-row items-start gap-2">
        <Text
          className="min-w-0 flex-1 text-[22px] leading-7 font-ryco-bold text-foreground"
          selectable
        >
          {header.title}
        </Text>
        {props.onEdit ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Edit title and description"
            hitSlop={8}
            onPress={props.onEdit}
            className="mt-0.5 h-8 w-8 items-center justify-center rounded-full bg-subtle active:bg-subtle-strong"
          >
            <SymbolView name="pencil" size={13} tintColor={editIconColor} />
          </Pressable>
        ) : null}
      </View>
      <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
        <Text className="shrink font-mono text-xs text-foreground-muted" numberOfLines={1}>
          {header.headRefName} → {header.baseRefName}
        </Text>
        <PullRequestDiffStats additions={props.additions} deletions={props.deletions} size="xs" />
        {props.changedFiles !== null ? (
          <Text className="text-xs text-foreground-tertiary">
            {props.changedFiles} {props.changedFiles === 1 ? "file" : "files"}
          </Text>
        ) : null}
      </View>
      {header.author || header.url ? (
        <View className="flex-row items-center gap-2">
          {header.author ? (
            <Text className="text-xs text-foreground-muted">
              by <Text className="font-ryco-bold text-foreground">@{header.author}</Text>
            </Text>
          ) : null}
          <View className="flex-1" />
          {header.url ? (
            <Pressable
              accessibilityRole="link"
              onPress={() => openWebLink(header.url)}
              className="active:opacity-60"
            >
              <Text className="text-xs font-ryco-bold text-primary">Open on {props.hostName}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
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

/** The checks at a glance; tapping it opens the Checks tab. */
function ChecksBar(props: {
  readonly counts: PullRequestCheckCounts | null;
  readonly description: string;
  readonly onPress: () => void;
}) {
  const chevron = useThemeColor("--color-icon-subtle") as string;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Checks: ${props.counts ? describeCheckCounts(props.counts) : props.description}`}
      onPress={props.onPress}
      className="mx-4 flex-row items-center gap-3 rounded-2xl bg-card px-4 py-3 active:bg-card-alt"
    >
      {props.counts ? (
        <PullRequestCheckRing counts={props.counts} size={26} strokeWidth={3.5} />
      ) : (
        <View className="h-[26px] w-[26px] rounded-full border-[3px] border-border" />
      )}
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-ryco-bold text-foreground">Checks</Text>
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {props.counts ? shortCheckCounts(props.counts) : props.description}
        </Text>
      </View>
      <SymbolView name="chevron.right" size={12} tintColor={chevron} />
    </Pressable>
  );
}

/** Every layer of the stack, from the base up; tap one to open it. */
function StackNavigator(props: {
  readonly stack: PullRequestStackNavigatorModel;
  readonly onOpen: (number: number) => void;
}) {
  const muted = useThemeColor("--color-icon-muted") as string;
  return (
    <View className="gap-2">
      <View className="flex-row items-center gap-1.5 px-5">
        <SymbolView name={PULL_REQUEST_STACK_SYMBOL as never} size={12} tintColor={muted} />
        <Text className="text-xs font-ryco-bold text-foreground-muted">
          Stack{props.stack.positionLabel ? ` · ${props.stack.positionLabel}` : ""}
        </Text>
        <Text className="font-mono text-2xs text-foreground-tertiary">
          on {props.stack.baseRefName}
        </Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}
      >
        {props.stack.layers.map((layer) => (
          <StackLayerChip key={layer.number} layer={layer} onOpen={props.onOpen} />
        ))}
      </ScrollView>
    </View>
  );
}

function StackLayerChip(props: {
  readonly layer: PullRequestStackNavigatorModel["layers"][number];
  readonly onOpen: (number: number) => void;
}) {
  const { layer } = props;
  const glyph = pullRequestStateGlyph(layer);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: layer.current }}
      accessibilityLabel={`Layer ${layer.position}, pull request ${layer.number}, ${layer.title}, ${glyph.label}`}
      disabled={layer.current}
      onPress={() => props.onOpen(layer.number)}
      className={cn(
        "max-w-56 flex-row items-center gap-2 rounded-xl px-3 py-2",
        layer.current ? "bg-subtle-strong" : "bg-card active:bg-card-alt",
      )}
    >
      <PullRequestStateIcon glyph={glyph} size={14} />
      <Text className="font-mono text-2xs text-foreground-muted">#{layer.number}</Text>
      <Text
        className={cn(
          "shrink text-xs",
          layer.current ? "font-ryco-bold text-foreground" : "text-foreground-secondary",
        )}
        numberOfLines={1}
      >
        {layer.title}
      </Text>
    </Pressable>
  );
}

function DetailSegments(props: {
  readonly selected: PullRequestDetailTab;
  readonly counts: Readonly<Record<PullRequestDetailTab, number | null>>;
  readonly onSelect: (tab: PullRequestDetailTab) => void;
}) {
  return (
    <View accessibilityRole="tablist" className="mx-4 flex-row rounded-xl bg-subtle p-0.5">
      {PULL_REQUEST_DETAIL_TABS.map((option) => {
        const selected = option.value === props.selected;
        const count = props.counts[option.value];
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => props.onSelect(option.value)}
            className={cn(
              "h-9 flex-1 flex-row items-center justify-center gap-1 rounded-[10px]",
              selected ? "bg-card" : "active:opacity-70",
            )}
          >
            <Text
              className={cn(
                "text-sm",
                selected ? "font-ryco-bold text-foreground" : "text-foreground-muted",
              )}
            >
              {option.label}
            </Text>
            {count !== null && count > 0 ? (
              <Text className="text-xs text-foreground-tertiary">{count}</Text>
            ) : null}
          </Pressable>
        );
      })}
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
  readonly viewedState: ViewedFileState | null;
  readonly pending: boolean;
  /** False when this session may not mark files (read-only node or role): the box only shows. */
  readonly canToggle: boolean;
  readonly onPress: (path: string) => void;
  readonly onToggleViewed: (path: string, viewed: boolean) => void;
}) {
  const { row } = props;
  const viewed = props.viewedState === "viewed";
  const success = useThemeColor("--color-success") as string;
  const muted = useThemeColor("--color-icon-subtle") as string;
  return (
    <View className="mx-4 mb-1.5 flex-row items-center overflow-hidden rounded-xl bg-card">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${row.path}${viewed ? ", viewed" : ""}`}
        onPress={() => props.onPress(row.path)}
        className="min-w-0 flex-1 flex-row items-center gap-3 py-2.5 pl-3.5 active:bg-card-alt"
      >
        <Text className="w-4 text-center font-mono text-xs font-ryco-bold text-foreground-muted">
          {row.statusLetter ?? "·"}
        </Text>
        <View className="min-w-0 flex-1">
          <Text
            className={cn(
              "font-mono text-sm",
              viewed ? "text-foreground-muted" : "text-foreground",
            )}
            numberOfLines={1}
          >
            {splitFilePath(row.path).name}
          </Text>
          {splitFilePath(row.path).directory ? (
            <Text className="font-mono text-2xs text-foreground-tertiary" numberOfLines={1}>
              {splitFilePath(row.path).directory}
            </Text>
          ) : null}
          {row.previousPath ? (
            <Text className="font-mono text-2xs text-foreground-tertiary" numberOfLines={1}>
              from {row.previousPath}
            </Text>
          ) : props.viewedState === "stale" ? (
            <Text className="text-2xs text-warning">Changed since you viewed it</Text>
          ) : null}
        </View>
        <Text className="font-mono text-2xs text-foreground-tertiary">
          {row.binary ? "binary" : row.diffStat}
        </Text>
      </Pressable>
      {props.viewedState !== null ? (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityLabel="Viewed"
          accessibilityState={{
            checked: viewed,
            busy: props.pending,
            disabled: !props.canToggle,
          }}
          disabled={props.pending || !props.canToggle}
          hitSlop={6}
          onPress={() => {
            void Haptics.selectionAsync();
            props.onToggleViewed(row.path, !viewed);
          }}
          className={cn(
            "w-12 items-center justify-center self-stretch active:opacity-60",
            !props.canToggle && "opacity-50",
          )}
        >
          <SymbolView
            name={(viewed ? "checkmark.circle.fill" : "circle") as never}
            size={20}
            tintColor={viewed ? success : muted}
          />
        </Pressable>
      ) : (
        <View className="w-3" />
      )}
    </View>
  );
}

/** How far the review is, and the way into the next file to read. */
function ReviewProgressCard(props: {
  readonly progress: PullRequestReviewProgress;
  readonly draftComments: number;
  readonly onReview: () => void;
}) {
  const { progress } = props;
  const done = progress.total > 0 && progress.viewed === progress.total;
  const share = progress.total === 0 ? 0 : progress.viewed / progress.total;
  return (
    <View className="mx-4 gap-3 rounded-2xl bg-card px-4 py-3.5">
      <View className="flex-row items-center gap-3">
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-ryco-bold text-foreground">
            Files viewed {progress.viewed} / {progress.total}
          </Text>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {done
              ? "Every file is viewed."
              : progress.supported
                ? "Marked on the host, so it matches the web."
                : "Open each file to read its changes."}
            {props.draftComments > 0
              ? ` ${props.draftComments} draft ${props.draftComments === 1 ? "comment" : "comments"}.`
              : ""}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={props.onReview}
          disabled={progress.total === 0}
          className="h-9 flex-row items-center gap-1 rounded-full bg-primary px-4 active:opacity-80 disabled:opacity-40"
        >
          <Text className="text-sm font-ryco-bold text-primary-foreground">
            {done ? "Read again" : progress.viewed > 0 ? "Continue" : "Review"}
          </Text>
        </Pressable>
      </View>
      {progress.supported ? (
        <View className="h-1.5 overflow-hidden rounded-full bg-subtle">
          <View className="h-full rounded-full bg-success" style={{ width: `${share * 100}%` }} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * One pull request: header, conversation, checks and files, plus review,
 * merge and branch update where the host, the viewer and the node allow them.
 */
export function PullRequestRouteScreen(props: PullRequestRouteProps) {
  const navigation = useNavigation();
  const environmentIdRaw = firstParam(props.route.params.environmentId);
  const projectIdRaw = firstParam(props.route.params.projectId);
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const projectId = projectIdRaw ? ProjectId.make(projectIdRaw) : null;
  const number = parsePullRequestNumberParam(props.route.params.number);
  const checkout = usePullRequestCheckout(environmentId, projectId);
  const provider = useSourceControlProvider(environmentId, checkout.cwd);
  const environments = useHomeEnvironments();
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  // A pull request read while the node is away is the copy kept on this phone.
  const offline =
    environment !== undefined &&
    environment.connectionState !== "connected" &&
    environment.connectionState !== "read-only";
  const pullRequest = usePullRequest({
    environmentId,
    cwd: checkout.cwd,
    number,
    provider,
  });
  const [tab, setTab] = useState<PullRequestDetailTab>("conversation");
  const diff = usePullRequestDiff({
    environmentId,
    cwd: checkout.cwd,
    number,
    detail: pullRequest.detail.data,
    enabled: tab === "files" && pullRequest.capabilities.diff,
  });
  const detail = pullRequest.detail.data;
  const filesViewed = usePullRequestFilesViewed({
    environmentId,
    cwd: checkout.cwd,
    number,
    headSha: detail?.headSha ?? null,
    active: tab === "files",
  });
  const reviewPaths = diff.files?.map((file) => file.path) ?? [];
  const reviewProgress = derivePullRequestReviewProgress(reviewPaths, filesViewed.data);
  const draftKey =
    environmentId !== null && checkout.cwd !== null && number !== null
      ? reviewDraftKey({ environmentId, cwd: checkout.cwd, number })
      : null;
  const draftComments = usePullRequestReviewDrafts((state) =>
    draftKey === null ? 0 : (state.draftsByKey[draftKey]?.comments.length ?? 0),
  );
  const hostName = resolveChangeRequestPresentationForKind(
    detail?.provider ?? "github",
  ).providerName;
  const items = usePullRequestDetailItems({
    tab,
    hostName,
    hostKnown: provider !== null,
    pullRequest,
    diff,
  });

  // The same readiness the thread screen sends with: connected, allowed to
  // change things, and not a cached view. A role the node refuses changes to
  // (a viewer) is offered none.
  const project = useStore((state) =>
    environmentId !== null && projectId !== null
      ? selectProjectByRef(state, scopeProjectRef(environmentId, projectId))
      : undefined,
  );
  const actions = usePullRequestActions({
    environmentId,
    cwd: checkout.cwd,
    number,
    detail,
    viewer: pullRequest.activity.data?.viewer ?? null,
    nextAction: pullRequest.nextAction,
    capabilities: pullRequest.capabilities,
    mutationReady: environment?.mutationReady === true,
    role: environment?.role,
    // A review the viewer started on the host only counts where the host reports it.
    hostPendingComments: pullRequest.capabilities.submitReview.pendingReview
      ? (pullRequest.activity.data?.pendingReview?.commentsCount ?? 0)
      : 0,
  });

  const [editSheet, setEditSheet] = useState<PullRequestEditSheet | null>(null);
  const mutedIcon = useThemeColor("--color-icon-muted") as string;
  usePullRequestLiveChecks({
    overall: pullRequest.checks.overall,
    open: detail?.state === "open",
    refresh: pullRequest.refreshDetail,
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

  const header = derivePullRequestHeader(detail, null);

  const openFile = (path: string, review = false) =>
    navigation.navigate("ProjectPullRequestFile", {
      environmentId,
      projectId,
      number: String(number),
      path: [...relativePathToRouteSegments(path)],
      ...(review ? { review: "1" } : {}),
    });
  const startReview = () => {
    const first = reviewProgress.firstUnviewed ?? reviewPaths[0];
    if (first !== undefined) openFile(first, true);
  };

  const loadError = pullRequest.detail.error?.message ?? null;
  const refreshing =
    (pullRequest.detail.isFetching && detail !== null) ||
    (pullRequest.activity.isFetching && pullRequest.activity.data !== null);

  const checkCounts = pullRequestCheckCounts(pullRequest.checks);
  const stack = derivePullRequestStackNavigator(detail?.stack, number);
  const openLayer = (layer: number) =>
    navigation.dispatch(
      StackActions.replace("ProjectPullRequest", {
        environmentId,
        projectId,
        number: String(layer),
      }),
    );
  const selectTab = (next: PullRequestDetailTab) => {
    if (next === tab) return;
    void Haptics.selectionAsync();
    setTab(next);
  };
  const listHeader = (
    <View className="gap-3 pb-2">
      {offline && detail !== null ? (
        <View className="mx-4 mt-2 flex-row items-center gap-2 rounded-xl bg-subtle px-3 py-2.5">
          <SymbolView name="wifi.slash" size={14} tintColor={mutedIcon} />
          <Text className="min-w-0 flex-1 text-xs text-foreground-muted">
            {environment.label} is offline. This is the copy saved on this phone.
          </Text>
        </View>
      ) : null}
      {header ? (
        <Header
          header={header}
          repository={
            project?.repositoryIdentity?.owner && project.repositoryIdentity.name
              ? `${project.repositoryIdentity.owner}/${project.repositoryIdentity.name}`
              : null
          }
          nextStep={describePullRequestNextStep(pullRequest.nextAction)}
          hostName={hostName}
          additions={detail?.additions ?? null}
          deletions={detail?.deletions ?? null}
          changedFiles={detail?.changedFiles ?? null}
          onEdit={actions.edits.edit ? () => setEditSheet("edit") : null}
        />
      ) : null}
      {loadError && detail === null ? (
        <View className="px-4 pt-3">
          <ErrorBanner message={loadError} />
        </View>
      ) : null}
      {detail ? (
        <ChecksBar
          counts={checkCounts}
          description={pullRequest.checks.description}
          onPress={() => selectTab("checks")}
        />
      ) : null}
      {detail ? (
        <PullRequestPeopleCard
          reviewers={derivePullRequestReviewers(detail)}
          labels={detail.labels ?? []}
          canEditReviewers={actions.edits.reviewers}
          canEditLabels={actions.edits.labels}
          onEditReviewers={() => setEditSheet("reviewers")}
          onEditLabels={() => setEditSheet("labels")}
        />
      ) : null}
      {stack ? <StackNavigator stack={stack} onOpen={openLayer} /> : null}
      <DetailSegments
        selected={tab}
        counts={{
          conversation: null,
          files: detail?.changedFiles ?? null,
          checks: pullRequest.checks.checks.length,
        }}
        onSelect={selectTab}
      />
      {tab === "conversation" && actions.edits.comment ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setEditSheet("comment")}
          className="mx-4 flex-row items-center gap-2.5 rounded-2xl bg-card px-4 py-3 active:bg-card-alt"
        >
          <SymbolView name="bubble.left" size={15} tintColor={mutedIcon} />
          <Text className="text-sm text-foreground-muted">Write a comment…</Text>
        </Pressable>
      ) : null}
      {tab === "files" && diff.status === "ready" ? (
        <ReviewProgressCard
          progress={reviewProgress}
          draftComments={draftComments}
          onReview={startReview}
        />
      ) : null}
      {tab === "files" && filesViewed.error ? (
        <Text className="px-5 text-xs text-warning">{filesViewed.error}</Text>
      ) : null}
      {pullRequest.detail.isLoading ||
      (tab === "conversation" && pullRequest.activity.isLoading) ||
      (tab === "files" && diff.status === "loading") ? (
        <LoadingStrip />
      ) : null}
    </View>
  );

  return (
    <View className="flex-1 bg-screen">
      <FlatList<PullRequestDetailItem>
        className="flex-1"
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
              return (
                <FileRow
                  row={item.row}
                  viewedState={
                    reviewProgress.supported
                      ? (reviewProgress.stateByPath.get(item.row.path) ?? "unviewed")
                      : null
                  }
                  pending={filesViewed.pendingPaths.has(item.row.path)}
                  canToggle={filesViewed.canMark}
                  onPress={openFile}
                  onToggleViewed={(path, next) => void filesViewed.setViewed(path, next)}
                />
              );
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
        contentContainerStyle={{ paddingBottom: PULL_REQUEST_ACTION_BAR_HEIGHT + 48 }}
      />
      <PullRequestActionBar control={actions} number={number} />
      <PullRequestEditSheets
        sheet={editSheet}
        control={actions}
        detail={detail}
        environmentId={environmentId}
        cwd={checkout.cwd}
        onClose={() => setEditSheet(null)}
      />
    </View>
  );
}
