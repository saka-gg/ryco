import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { ScrollView, View } from "react-native";

import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import { EnvironmentId, ThreadId } from "@ryco/contracts/base-schemas";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { LoadingStrip } from "../../components/LoadingStrip";
import { selectThreadByRef, useStore } from "../../state/threadsRuntime";
import { buildFullThreadDiffInput, useCheckpointDiff } from "./useReviewDiffData";

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

type ReviewSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

// Review/diff. §3-18: the turn diffs come from thread.turnDiffSummaries; the full
// content is fetched through the §6 checkpoint-diff cache. NOTE (owner-Simulator):
// the native review-diff CANVAS (RycoReviewDiffSurface, rows/tokens JSON) is a
// follow-up — this renders the unified diff in a JS text surface (graceful
// degradation, §3-19), which is what the JS path falls back to when the native
// view can't resolve.
export function ReviewSheet(props: ReviewSheetProps) {
  const navigation = useNavigation();
  const environmentIdRaw = firstParam(props.route.params.environmentId);
  const threadIdRaw = firstParam(props.route.params.threadId);
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const threadId = threadIdRaw ? ThreadId.make(threadIdRaw) : null;

  const thread = useStore((state) =>
    environmentId && threadId
      ? selectThreadByRef(state, scopeThreadRef(environmentId, threadId))
      : null,
  );
  const summaries = thread?.turnDiffSummaries ?? [];

  const diffState = useCheckpointDiff(
    buildFullThreadDiffInput(environmentId, threadId, summaries, false),
  );

  const totalFiles = summaries.reduce((count, summary) => count + summary.files.length, 0);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-screen"
      contentContainerStyle={{ paddingVertical: 12 }}
    >
      {diffState.error ? <ErrorBanner message={diffState.error.message} /> : null}
      {diffState.isLoading ? <LoadingStrip /> : null}

      {summaries.length === 0 && !diffState.isLoading ? (
        <View className="px-4 py-16">
          <EmptyState
            variant="plain"
            title="No changes"
            detail="This thread has no reviewable diffs yet."
          />
        </View>
      ) : (
        <>
          <Text className="px-5 pb-1 text-xs font-ryco-bold uppercase tracking-wide text-foreground-muted">
            {totalFiles} file{totalFiles === 1 ? "" : "s"} changed
          </Text>
          {diffState.data?.diff ? (
            <View className="mx-4 my-2 overflow-hidden rounded-2xl border border-border bg-card">
              <ScrollView horizontal contentContainerStyle={{ padding: 12 }}>
                <Text className="font-mono text-xs text-foreground" selectable>
                  {diffState.data.diff}
                </Text>
              </ScrollView>
            </View>
          ) : !diffState.isLoading ? (
            <View className="px-4 py-8">
              <EmptyState
                variant="plain"
                title="Diff unavailable"
                detail="The diff could not be loaded."
              />
            </View>
          ) : null}
        </>
      )}

      {environmentId && threadId ? (
        <View className="px-4 pt-2">
          <Text
            onPress={() =>
              navigation.navigate("ThreadReviewComment", {
                environmentId,
                threadId,
              })
            }
            className="text-center text-sm font-ryco-bold text-primary"
          >
            Add a review comment
          </Text>
        </View>
      ) : null}
    </ScrollView>
  );
}
