import type { StaticScreenProps } from "@react-navigation/native";
import {
  comparesWorkingTree,
  comparisonStorageKey,
  createComparisonController,
} from "@ryco/client-runtime/state/comparison";
import { createLineBlameReader } from "@ryco/client-runtime/state/comparison/lineBlame";
import type { EnvironmentId, GitComparisonSelection, VcsRef } from "@ryco/contracts";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, RefreshControl, ScrollView, Switch, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { errorMessageOr } from "../../lib/errorMessage";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { SegmentedControl } from "../../components/SegmentedControl";
import { ensureEnvironmentApi } from "../../connection/environmentApi";
import { vcsRefsQuery } from "../../rpc/sourceControlAtoms";
import { useMobileQuery } from "../../rpc/useMobileQuery";
import { mobileKV } from "../../platform/kv";
import {
  formatPullRequestDiffStat,
  parsePullRequestDiffRows,
  PULL_REQUEST_DIFF_EXCERPT_ROWS,
  readPatchFilesInOrder,
  type PullRequestDiffRow,
  type PullRequestPatchFile,
} from "../pullRequests/pullRequestDiffModel";
import { blameSummary, blameTargetForRow } from "./gitToolsModel";
import { DiffRowsView, LoadingRow, SectionTitle, ToolTextField } from "./gitToolsParts";
import { useSourceControlTarget, type SourceControlRouteParams } from "./useSourceControlTarget";

type CompareRouteProps = StaticScreenProps<SourceControlRouteParams>;

const IDLE_STORE = {
  getSnapshot: () => null,
  subscribe: () => () => {},
};

function defaultRefName(refs: ReadonlyArray<VcsRef>): string | null {
  const local = refs.find((ref) => ref.isDefault && !ref.isRemote);
  return local ? local.name : (refs.find((ref) => ref.isDefault)?.name ?? null);
}

/** The selection a control change asks for, keeping what it does not change. */
function nextComparisonSelection(
  current: GitComparisonSelection | null,
  typedRef: string,
  next: {
    readonly ref?: string;
    readonly mode?: GitComparisonSelection["mode"];
    readonly workingTree?: boolean;
  },
): GitComparisonSelection | null {
  const ref = (next.ref ?? current?.ref ?? typedRef).trim();
  if (!ref) return null;
  const mode = next.mode ?? current?.mode ?? "mergeBase";
  const workingTree = next.workingTree ?? (current ? comparesWorkingTree(current) : false);
  return { ref, mode, ...(workingTree ? { target: "workingTree" as const } : {}) };
}

const NO_REFS: ReadonlyArray<VcsRef> = [];

function useComparison(environmentId: EnvironmentId | null, cwd: string | null) {
  const controller = useMemo(() => {
    if (!environmentId || !cwd) return null;
    return createComparisonController({
      storage: mobileKV,
      storageKey: comparisonStorageKey(environmentId, cwd),
      read: (selection, knownRevision) =>
        ensureEnvironmentApi(environmentId).vcs.readComparison({
          cwd,
          selection,
          ignoreWhitespace: false,
          ...(knownRevision ? { knownRevision } : {}),
        }),
    });
  }, [cwd, environmentId]);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (!controller) return;
    setHydrated(false);
    void controller.hydrate().finally(() => setHydrated(true));
    return () => controller.dispose();
  }, [controller]);
  const source = controller ?? IDLE_STORE;
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot);
  return { controller, state, hydrated };
}

function CompareFile(props: {
  readonly file: PullRequestPatchFile;
  readonly onBlame: (file: PullRequestPatchFile, row: PullRequestDiffRow) => void;
  readonly blame: { readonly row: PullRequestDiffRow; readonly text: string } | null;
}) {
  const [open, setOpen] = useState(false);
  const parsed = useMemo(
    () =>
      open
        ? parsePullRequestDiffRows(props.file.patch, { maxRows: PULL_REQUEST_DIFF_EXCERPT_ROWS })
        : null,
    [open, props.file.patch],
  );
  return (
    <View className="overflow-hidden rounded-[18px] bg-card">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${props.file.path}, ${open ? "hide" : "show"} diff`}
        onPress={() => setOpen((value) => !value)}
        className="px-4 py-2.5 active:bg-subtle"
      >
        <Text className="font-mono text-[12px] text-foreground" numberOfLines={1}>
          {props.file.path}
        </Text>
        <Text className="mt-0.5 text-[11px] font-ryco-medium text-foreground-muted">
          {props.file.status} ·{" "}
          {formatPullRequestDiffStat(props.file.additions, props.file.deletions)}
        </Text>
      </Pressable>
      {parsed ? (
        <View className="border-t border-separator">
          {props.file.binary ? (
            <Text className="px-4 py-3 text-[12px] text-foreground-muted">Binary file</Text>
          ) : (
            <DiffRowsView
              rows={parsed.rows}
              selectedRow={props.blame ? props.blame.row : null}
              onLongPressRow={(row) => props.onBlame(props.file, row)}
            />
          )}
          {parsed.truncated ? (
            <Text className="px-4 py-2 text-[11px] text-foreground-muted">
              Showing the first {parsed.rows.length} of {parsed.totalRows} lines.
            </Text>
          ) : null}
          {props.blame ? (
            <View className="border-t border-separator bg-subtle px-4 py-2.5">
              <Text className="text-[12px] leading-5 text-foreground">{props.blame.text}</Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Compare the checkout with a branch, tag or commit — from where they forked
 * (merge base) or directly, against HEAD or the working files — and
 * long-press a line to see who last changed it.
 */
export function SourceControlCompareRouteScreen(props: CompareRouteProps) {
  const target = useSourceControlTarget(props.route.params);
  const { environmentId, cwd } = target;
  const { controller, state, hydrated } = useComparison(environmentId, cwd);
  const [refText, setRefText] = useState("");
  const [blame, setBlame] = useState<{
    readonly path: string;
    readonly row: PullRequestDiffRow;
    readonly text: string;
  } | null>(null);
  const selection = state ? state.selection : null;
  const data = state ? state.data : null;

  const refsRead = useMobileQuery(vcsRefsQuery, { environmentId, cwd }, environmentId);
  const refs = refsRead.data?.refs ?? NO_REFS;

  // Start from the default branch, but only once the saved choice had its chance.
  useEffect(() => {
    if (!controller || !hydrated || selection || refs.length === 0) return;
    const ref = defaultRefName(refs);
    if (ref) controller.setSelection({ ref, mode: "mergeBase" });
  }, [controller, hydrated, refs, selection]);

  useEffect(() => {
    if (selection) setRefText(selection.ref);
    setBlame(null);
  }, [selection]);

  const blameReader = useMemo(() => {
    if (!environmentId || !data) return null;
    return createLineBlameReader({
      environmentId,
      source: data.source,
      read: (input) => ensureEnvironmentApi(environmentId).vcs.readLineBlame(input),
    });
  }, [data, environmentId]);
  useEffect(() => () => blameReader?.dispose(), [blameReader]);

  const files = useMemo(() => (data ? readPatchFilesInOrder(data.patch) : []), [data]);

  const select = (next: {
    readonly ref?: string;
    readonly mode?: GitComparisonSelection["mode"];
    readonly workingTree?: boolean;
  }) => {
    if (!controller) return;
    const nextSelection = nextComparisonSelection(selection, refText, next);
    if (nextSelection) controller.setSelection(nextSelection);
  };

  const showBlame = (file: PullRequestPatchFile, row: PullRequestDiffRow) => {
    if (!data || !blameReader) return;
    const lineTarget = blameTargetForRow(data.source, file, row);
    if (!lineTarget) {
      setBlame({ path: file.path, row, text: "Added lines have no earlier commit to blame." });
      return;
    }
    setBlame({ path: file.path, row, text: "Reading blame…" });
    void blameReader.read(lineTarget).then(
      (result) =>
        setBlame({
          path: file.path,
          row,
          text: result.kind === "committed" ? blameSummary(result) : result.reason,
        }),
      (cause: unknown) =>
        setBlame({
          path: file.path,
          row,
          text: errorMessageOr(cause, "Blame unavailable."),
        }),
    );
  };

  if (!environmentId || !cwd || !controller) {
    return (
      <View className="flex-1 bg-screen px-5 py-16">
        <EmptyState variant="plain" title="Workspace unavailable" detail="Reconnect and retry." />
      </View>
    );
  }

  const suggestions = refs.filter((ref) => !ref.current && ref.name !== selection?.ref).slice(0, 6);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl refreshing={false} onRefresh={() => void controller.refresh()} />
      }
      className="flex-1 bg-screen"
      contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 64 }}
    >
      <ToolTextField
        mono
        value={refText}
        onChangeText={setRefText}
        placeholder="Branch, tag or commit"
        accessibilityLabel="Compare with"
        returnKeyType="go"
        onSubmitEditing={() => select({ ref: refText })}
      />
      {suggestions.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View className="flex-row gap-2">
            {suggestions.map((ref) => (
              <Pressable
                key={`${ref.isRemote ? "r" : "l"}:${ref.name}`}
                onPress={() => select({ ref: ref.name })}
                className="rounded-full bg-subtle-strong px-3 py-1.5 active:opacity-70"
              >
                <Text className="font-mono text-[12px] text-foreground">{ref.name}</Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      ) : null}
      <SegmentedControl
        value={selection?.mode ?? "mergeBase"}
        onChange={(mode) => select({ mode })}
        options={[
          { value: "mergeBase", label: "Since fork" },
          { value: "direct", label: "Directly" },
        ]}
      />
      <View className="flex-row items-center justify-between rounded-[18px] bg-card px-4 py-2.5">
        <View className="flex-1 pr-3">
          <Text className="text-[15px] font-ryco-medium text-foreground">
            Include working files
          </Text>
          <Text className="mt-0.5 text-[12px] text-foreground-muted">
            Compare with uncommitted edits instead of HEAD
          </Text>
        </View>
        <Switch
          value={selection ? comparesWorkingTree(selection) : false}
          onValueChange={(value) => select({ workingTree: value })}
        />
      </View>
      {state?.error ? <ErrorBanner message={state.error} /> : null}
      {state?.refMoved ? (
        <Text className="px-1 text-[12px] text-foreground-muted">
          {selection?.ref} moved since the last read.
        </Text>
      ) : null}
      {state?.isLoading && !data ? <LoadingRow label="Comparing…" /> : null}
      {data ? (
        <SectionTitle>
          {files.length} file{files.length === 1 ? "" : "s"} · long-press a line for blame
        </SectionTitle>
      ) : null}
      {data && files.length === 0 ? (
        <EmptyState variant="plain" title="No differences" detail="Both sides are identical." />
      ) : null}
      {files.map((file, index) => (
        <CompareFile
          key={`${index}:${file.path}`}
          file={file}
          onBlame={showBlame}
          blame={blame && blame.path === file.path ? blame : null}
        />
      ))}
    </ScrollView>
  );
}
