import { type StaticScreenProps } from "@react-navigation/native";
import type { WorkItemTransition } from "@ryco/contracts";
import { WS_METHODS } from "@ryco/contracts/rpc";
import { useEffect, useMemo, useState } from "react";
import { Alert, FlatList, Pressable, RefreshControl, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { LoadingStrip } from "../../components/LoadingStrip";
import { openWebLink } from "../../lib/openWebLink";
import { refreshProjectExplorerReads } from "../../rpc/projectExplorerAtoms";
import {
  ChipRow,
  FilterChip,
  PullRequestMarkdown,
  SectionTitle,
} from "../pullRequests/PullRequestParts";
import { commentBodyToSend } from "./issuesModel";
import { explorerScopeFromParams, parseWorkItemKeyParam } from "./projectExplorerModel";
import {
  CardButton,
  CommentCard,
  CommentSheet,
  ProblemState,
  WorkItemStatePill,
} from "./ProjectExplorerParts";
import { useExplorerChange } from "./useExplorerChange";
import { useExplorerNavigation } from "./useExplorerNavigation";
import { useWorkItem } from "./useProjectExplorerData";
import {
  deriveWorkItemDetail,
  deriveWorkItemDetailItems,
  transitionLabel,
  type WorkItemDetailItem,
  type WorkItemDetailView,
} from "./workItemsModel";

type ProjectWorkItemRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId: string;
  readonly key: string;
}>;

function WorkItemHeaderCard(props: { readonly view: WorkItemDetailView }) {
  const { view } = props;
  return (
    <View className="mx-4 mt-3 gap-2 rounded-[22px] border border-border bg-card p-4">
      <View className="flex-row items-center gap-2">
        <WorkItemStatePill tone={view.tone} label={view.stateLabel} />
        <Text className="font-mono text-xs text-foreground-muted">{view.key}</Text>
      </View>
      <Text className="text-lg font-ryco-bold text-foreground" selectable>
        {view.title}
      </Text>
      {view.fields.length > 0 ? (
        <View className="gap-1">
          {view.fields.map((field) => (
            <View key={field.label} className="flex-row gap-3">
              <Text className="w-20 text-xs text-foreground-tertiary">{field.label}</Text>
              <Text className="min-w-0 flex-1 text-xs text-foreground" numberOfLines={2}>
                {field.value}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {view.labels.length > 0 ? (
        <View className="flex-row flex-wrap gap-1.5">
          {view.labels.map((label) => (
            <View key={label} className="rounded-full bg-subtle px-2 py-0.5">
              <Text className="text-2xs font-ryco-medium text-foreground-secondary">{label}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {view.url ? (
        <Pressable
          accessibilityRole="link"
          onPress={() => openWebLink(view.url)}
          className="self-start active:opacity-70"
        >
          <Text className="text-sm font-ryco-bold text-primary">Open in Jira</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** One Jira work item: its fields, description and comments, a comment and a status move. */
export function ProjectWorkItemRouteScreen(props: ProjectWorkItemRouteProps) {
  const { environmentId, projectId } = explorerScopeFromParams(props.route.params);
  const key = parseWorkItemKeyParam(props.route.params.key);
  const item = useWorkItem({ environmentId, projectId, key });
  const detail = item.detail.data;
  const view = useMemo(() => (detail === null ? null : deriveWorkItemDetail(detail)), [detail]);
  const items = useMemo(() => deriveWorkItemDetailItems(view), [view]);
  const explorer = useExplorerNavigation(environmentId, projectId);
  const { navigation } = explorer;
  const change = useExplorerChange(environmentId);
  const commentOffer = change.offer(WS_METHODS.workItemsAddComment);
  const transitionOffer = change.offer(WS_METHODS.workItemsTransition);
  const [composing, setComposing] = useState(false);

  useEffect(() => {
    if (key !== null) navigation.setOptions({ title: key });
  }, [key, navigation]);

  if (environmentId === null || projectId === null || key === null) {
    return (
      <View className="flex-1 bg-screen px-5 py-16">
        <EmptyState
          variant="plain"
          title="Work item unavailable"
          detail="This link does not name a Jira work item."
        />
      </View>
    );
  }

  const refreshWorkItems = () =>
    refreshProjectExplorerReads({ environmentId, scope: projectId, family: "work-items" });

  const sendComment = (draft: string, done: () => void) => {
    const body = commentBodyToSend(draft);
    if (body === null) return;
    change.run({
      kind: "comment",
      failure: "The comment was not posted. Try again.",
      perform: (client) => client.workItems.addComment({ projectId, key, body }),
      onDone: () => {
        refreshWorkItems();
        done();
      },
    });
  };

  const transition = (target: WorkItemTransition) =>
    Alert.alert(`${transitionLabel(target)}?`, `Moves ${key} in Jira.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Move",
        onPress: () =>
          change.run({
            kind: `transition:${target.id}`,
            failure: "The work item was not moved. Try again.",
            perform: (client) =>
              client.workItems.transition({ projectId, key, transitionId: target.id }),
            onDone: refreshWorkItems,
          }),
      },
    ]);

  const busy = change.pending !== null;
  const transitions = view === null ? [] : view.transitions;

  const listHeader = (
    <View className="gap-3 pb-2">
      {view !== null ? <WorkItemHeaderCard view={view} /> : null}
      {item.detail.isLoading ? <LoadingStrip /> : null}
      {item.problem !== null && view !== null ? (
        <View className="px-4">
          <ErrorBanner message={item.problem.detail} />
        </View>
      ) : null}
      {change.error && !composing ? (
        <View className="px-4">
          <ErrorBanner message={change.error} />
        </View>
      ) : null}
      {transitions.length > 0 && transitionOffer.offered ? (
        <View className="gap-1.5">
          <SectionTitle title="Move to" />
          <ChipRow>
            {transitions.map((target) => (
              <FilterChip
                key={target.id}
                label={
                  change.pending === `transition:${target.id}` ? "Moving…" : transitionLabel(target)
                }
                selected={false}
                onPress={() => {
                  if (!busy && transitionOffer.blockedReason === null) transition(target);
                }}
              />
            ))}
          </ChipRow>
          {transitionOffer.blockedReason ? (
            <Text className="px-5 text-xs text-foreground-muted">
              {transitionOffer.blockedReason}
            </Text>
          ) : null}
        </View>
      ) : null}
      {view !== null && commentOffer.offered ? (
        <View className="flex-row px-4">
          <CardButton label="Comment" symbol="text.bubble" onPress={() => setComposing(true)} />
        </View>
      ) : null}
    </View>
  );

  return (
    <>
      <FlatList<WorkItemDetailItem>
        className="flex-1 bg-screen"
        contentInsetAdjustmentBehavior="automatic"
        data={items}
        keyExtractor={(entry) => entry.key}
        ListHeaderComponent={listHeader}
        renderItem={({ item: entry }) => {
          switch (entry.kind) {
            case "description":
              return (
                <View className="mx-4 mb-3 rounded-2xl border border-border bg-card px-4 py-3">
                  <PullRequestMarkdown markdown={entry.body} />
                </View>
              );
            case "section":
              return <SectionTitle title={entry.title} detail={entry.detail} />;
            case "linked":
              return (
                <Pressable
                  accessibilityRole="link"
                  onPress={() => openWebLink(entry.change.url)}
                  className="mx-4 mb-1.5 flex-row items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-2.5 active:bg-card-alt"
                >
                  <Text className="font-mono text-xs text-foreground-muted">
                    #{entry.change.number}
                  </Text>
                  <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
                    {entry.change.title}
                  </Text>
                  <Text className="text-2xs capitalize text-foreground-tertiary">
                    {entry.change.state}
                  </Text>
                </Pressable>
              );
            case "comment":
              return (
                <CommentCard
                  author={entry.row.author}
                  atMs={entry.row.atMs}
                  body={entry.row.body}
                />
              );
            case "note":
              return <Text className="px-5 pb-2 text-xs text-foreground-muted">{entry.text}</Text>;
          }
        }}
        ListEmptyComponent={
          view === null && item.problem !== null ? <ProblemState problem={item.problem} /> : null
        }
        refreshControl={
          <RefreshControl
            refreshing={item.detail.isFetching && detail !== null}
            onRefresh={() => void item.detail.refetch()}
          />
        }
        contentContainerStyle={{ paddingBottom: 48 }}
      />
      <CommentSheet
        visible={composing}
        title="Comment"
        sending={change.pending === "comment"}
        error={change.error}
        blockedReason={commentOffer.blockedReason}
        canSend={(draft) => commentBodyToSend(draft) !== null}
        onClose={() => {
          setComposing(false);
          change.clearError();
        }}
        onSend={sendComment}
      />
    </>
  );
}
