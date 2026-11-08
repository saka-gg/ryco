import { type StaticScreenProps } from "@react-navigation/native";
import { WS_METHODS } from "@ryco/contracts/rpc";
import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { LoadingStrip } from "../../components/LoadingStrip";
import { openWebLink } from "../../lib/openWebLink";
import { refreshProjectExplorerReads } from "../../rpc/projectExplorerAtoms";
import { parsePullRequestNumberParam } from "../pullRequests/pullRequestDetailModel";
import {
  ActorLine,
  PullRequestMarkdown,
  PullRequestStatePill,
  SectionTitle,
} from "../pullRequests/PullRequestParts";
import { usePullRequestCheckout } from "../pullRequests/usePullRequestData";
import {
  commentBodyToSend,
  deriveIssueDetail,
  deriveIssueDetailItems,
  type IssueDetailItem,
  type IssueHeader,
} from "./issuesModel";
import { explorerScopeFromParams } from "./projectExplorerModel";
import {
  CardButton,
  CommentCard,
  CommentSheet,
  LabelRow,
  ProblemState,
} from "./ProjectExplorerParts";
import { useExplorerChange } from "./useExplorerChange";
import { useExplorerNavigation } from "./useExplorerNavigation";
import { useIssue } from "./useProjectExplorerData";

type ProjectIssueRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId: string;
  readonly number: string;
}>;

function IssueHeaderCard(props: {
  readonly header: IssueHeader;
  readonly onOpenPullRequest: (number: number) => void;
}) {
  const { header } = props;
  return (
    <View className="mx-4 mt-3 gap-2 rounded-[22px] border border-border bg-card p-4">
      <View className="flex-row items-center gap-2">
        <PullRequestStatePill
          tone={header.state === "open" ? "open" : "merged"}
          label={header.stateLabel}
        />
        <Text className="font-mono text-xs text-foreground-muted">#{header.number}</Text>
      </View>
      <Text className="text-lg font-ryco-bold text-foreground" selectable>
        {header.title}
      </Text>
      <ActorLine author={header.author} atMs={header.updatedAtMs}>
        opened this issue
      </ActorLine>
      <LabelRow labels={header.labels} />
      {header.assignees.length > 0 ? (
        <Text className="text-xs text-foreground-muted" numberOfLines={2}>
          Assigned to {header.assignees.map((login) => `@${login}`).join(", ")}
        </Text>
      ) : null}
      {header.linkedPullRequests.length > 0 ? (
        <View className="flex-row flex-wrap items-center gap-2">
          <Text className="text-xs text-foreground-muted">Linked</Text>
          {header.linkedPullRequests.map((number) => (
            <Pressable
              key={number}
              accessibilityRole="link"
              onPress={() => props.onOpenPullRequest(number)}
              className="rounded-full bg-subtle px-2 py-0.5 active:opacity-70"
            >
              <Text className="font-mono text-2xs text-foreground-secondary">#{number}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <Pressable
        accessibilityRole="link"
        onPress={() => openWebLink(header.url)}
        className="self-start active:opacity-70"
      >
        <Text className="text-sm font-ryco-bold text-primary">Open on {header.hostName}</Text>
      </Pressable>
    </View>
  );
}

/** One issue: its description, labels and comments, and a comment of the reader's own. */
export function ProjectIssueRouteScreen(props: ProjectIssueRouteProps) {
  const { environmentId, projectId } = explorerScopeFromParams(props.route.params);
  const number = parsePullRequestNumberParam(props.route.params.number);
  const checkout = usePullRequestCheckout(environmentId, projectId);
  const cwd = checkout.cwd;
  const issue = useIssue({ environmentId, cwd, number });
  const detail = issue.detail.data;
  const view = useMemo(() => (detail === null ? null : deriveIssueDetail(detail)), [detail]);
  const items = useMemo(() => deriveIssueDetailItems(view), [view]);
  const explorer = useExplorerNavigation(environmentId, projectId);
  const { navigation } = explorer;
  const change = useExplorerChange(environmentId);
  const commentOffer = change.offer(WS_METHODS.sourceControlAddIssueComment);
  const [composing, setComposing] = useState(false);

  useEffect(() => {
    if (number !== null) navigation.setOptions({ title: `#${number}` });
  }, [navigation, number]);

  if (environmentId === null || projectId === null || number === null || cwd === null) {
    return (
      <View className="flex-1 bg-screen px-5 py-16">
        <EmptyState
          variant="plain"
          title="Issue unavailable"
          detail="The selected node has not published this project yet."
        />
      </View>
    );
  }

  const sendComment = (draft: string, done: () => void) => {
    const body = commentBodyToSend(draft);
    if (body === null) return;
    change.run({
      kind: "comment",
      failure: "The comment was not posted. Try again.",
      perform: (client) =>
        client.sourceControl.addIssueComment({ cwd, reference: String(number), body }),
      onDone: () => {
        refreshProjectExplorerReads({ environmentId, scope: cwd, family: "issues" });
        done();
      },
    });
  };

  const listHeader = (
    <View className="gap-3 pb-2">
      {view !== null ? (
        <IssueHeaderCard header={view.header} onOpenPullRequest={explorer.openPullRequest} />
      ) : null}
      {issue.detail.isLoading ? <LoadingStrip /> : null}
      {issue.problem !== null && view !== null ? (
        <View className="px-4">
          <ErrorBanner message={issue.problem.detail} />
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
      <FlatList<IssueDetailItem>
        className="flex-1 bg-screen"
        contentInsetAdjustmentBehavior="automatic"
        data={items}
        keyExtractor={(item) => item.key}
        ListHeaderComponent={listHeader}
        renderItem={({ item }) => {
          switch (item.kind) {
            case "body":
              return (
                <View className="mx-4 mb-3 rounded-2xl border border-border bg-card px-4 py-3">
                  <PullRequestMarkdown markdown={item.body} />
                </View>
              );
            case "section":
              return <SectionTitle title={item.title} detail={item.detail} />;
            case "comment":
              return (
                <CommentCard author={item.row.author} atMs={item.row.atMs} body={item.row.body} />
              );
            case "note":
              return <Text className="px-5 pb-2 text-xs text-foreground-muted">{item.text}</Text>;
          }
        }}
        ListEmptyComponent={
          view === null && issue.problem !== null ? <ProblemState problem={issue.problem} /> : null
        }
        refreshControl={
          <RefreshControl
            refreshing={issue.detail.isFetching && detail !== null}
            onRefresh={() => void issue.detail.refetch()}
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
