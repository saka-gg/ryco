import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { CheckpointDiffFileIndex } from "@ryco/client-runtime/rpc/checkpointDiffFiles";
import type { OrchestrationTurnDiffFile } from "@ryco/contracts/orchestration";

import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import { EnvironmentId, ThreadId } from "@ryco/contracts/base-schemas";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { LoadingStrip } from "../../components/LoadingStrip";
import { selectThreadByRef, useStore } from "../../state/threadsRuntime";
import type { CheckpointDiffInput } from "../../rpc/checkpointDiffAtoms";
import {
  buildFullThreadDiffInput,
  useCheckpointDiff,
  useCheckpointDiffFileIndex,
  useCheckpointDiffFilePatch,
} from "./useReviewDiffData";

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

  const diffInput = buildFullThreadDiffInput(environmentId, threadId, summaries, false);
  const diffState = useCheckpointDiff(diffInput);
  // The file list first; a file's patch loads when it is opened (D6).
  const fileIndex = useCheckpointDiffFileIndex(diffState);

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
          {fileIndex && fileIndex.files.length > 0 ? (
            <View className="mx-4 my-2 overflow-hidden rounded-2xl border border-border bg-card">
              {fileIndex.files.map((file) => (
                <ReviewDiffFile key={file.index} input={diffInput} index={fileIndex} file={file} />
              ))}
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

/** One changed file: its path and counts, and its patch once opened. */
function ReviewDiffFile(props: {
  readonly input: CheckpointDiffInput;
  readonly index: CheckpointDiffFileIndex;
  readonly file: OrchestrationTurnDiffFile;
}) {
  const { file } = props;
  const [open, setOpen] = useState(false);
  const patch = useCheckpointDiffFilePatch(props.input, props.index, file.index, open);
  return (
    <View className="border-b border-separator">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        className="flex-row items-center gap-2 px-3 py-2.5 active:opacity-70"
      >
        <Text className="flex-1 font-mono text-xs text-foreground" numberOfLines={1}>
          {file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
        </Text>
        {file.binary ? (
          <Text className="text-xs text-foreground-muted">binary</Text>
        ) : (
          <Text className="font-mono text-xs text-foreground-muted">
            +{file.additions} −{file.deletions}
          </Text>
        )}
      </Pressable>
      {open ? (
        patch.patch !== null ? (
          <ScrollView horizontal contentContainerStyle={{ padding: 12 }}>
            <Text className="font-mono text-xs text-foreground" selectable>
              {patch.patch}
            </Text>
          </ScrollView>
        ) : patch.error !== null ? (
          <Text className="px-3 pb-2.5 text-xs text-danger">{patch.error}</Text>
        ) : (
          <LoadingStrip />
        )
      ) : null}
    </View>
  );
}
