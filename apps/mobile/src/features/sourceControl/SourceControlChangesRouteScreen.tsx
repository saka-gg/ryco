import type { StaticScreenProps } from "@react-navigation/native";
import {
  createLocalChangesController,
  type LocalChangesStagedCommit,
} from "@ryco/client-runtime/state/comparison";
import type { EnvironmentId, GitLocalChangesScope } from "@ryco/contracts";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { LoadingStrip } from "../../components/LoadingStrip";
import { ErrorBanner } from "../../components/ErrorBanner";
import { SegmentedControl } from "../../components/SegmentedControl";
import { ensureEnvironmentApi } from "../../connection/environmentApi";
import { uuidv4 } from "../../lib/uuid";
import { localChangesMirror } from "../../rpc/sourceControlAtoms";
import { useSavedMirror } from "../../rpc/useMobileQuery";
import { formatPullRequestDiffStat } from "../pullRequests/pullRequestDiffModel";
import {
  buildChangeFiles,
  CHANGE_HUNK_PREVIEW_ROWS,
  changeCounts,
  changeFileStartsCollapsed,
  stageVerb,
  type ChangeFile,
  type ChangeHunk,
} from "./gitToolsModel";
import { DiffRowsView, LoadingRow, PillButton, ToolTextField } from "./gitToolsParts";
import { useSourceControlTarget, type SourceControlRouteParams } from "./useSourceControlTarget";

type ChangesRouteProps = StaticScreenProps<SourceControlRouteParams>;

const IDLE_CONTROLLER = {
  getSnapshot: () => null,
  subscribe: () => () => {},
};

function useLocalChangesController(environmentId: EnvironmentId | null, cwd: string | null) {
  const controller = useMemo(() => {
    if (!environmentId || !cwd) return null;
    return createLocalChangesController({
      cwd,
      read: () => ensureEnvironmentApi(environmentId).vcs.readLocalChanges({ cwd }),
      apply: (input) => ensureEnvironmentApi(environmentId).vcs.applyIndexPatch(input),
    });
  }, [cwd, environmentId]);
  useEffect(() => {
    void controller?.refresh();
  }, [controller]);
  const source = controller ?? IDLE_CONTROLLER;
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot);
  return { controller, state };
}

/** Commits exactly the reviewed index (`stagedOnly`), bound to the revision it was read at. */
async function commitStaged(
  environmentId: EnvironmentId,
  commit: LocalChangesStagedCommit,
): Promise<void> {
  await ensureEnvironmentApi(environmentId).git.runStackedAction({
    actionId: uuidv4(),
    cwd: commit.cwd,
    action: "commit",
    stagedOnly: { expectedRevision: commit.expectedRevision },
    ...(commit.commitMessage ? { commitMessage: commit.commitMessage } : {}),
  });
}

function HunkBlock(props: {
  readonly hunk: ChangeHunk;
  readonly verb: string;
  readonly canAct: boolean;
  readonly onAct: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? props.hunk.rows : props.hunk.rows.slice(0, CHANGE_HUNK_PREVIEW_ROWS);
  const hidden = props.hunk.rows.length - rows.length;
  return (
    <View className="border-t border-separator">
      <View className="flex-row items-center gap-2 bg-accent-bg py-1 pl-3 pr-1.5">
        <Text className="flex-1 font-mono text-[11px] text-foreground-muted" numberOfLines={1}>
          {props.hunk.header}
        </Text>
        {props.canAct ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${props.verb} hunk ${props.hunk.index + 1}`}
            onPress={props.onAct}
            hitSlop={6}
            className="rounded-full bg-card px-2.5 py-1 active:opacity-70"
          >
            <Text className="text-[11px] font-ryco-bold text-foreground">{props.verb} hunk</Text>
          </Pressable>
        ) : null}
      </View>
      <DiffRowsView rows={rows} />
      {hidden > 0 ? (
        <Pressable onPress={() => setExpanded(true)} className="px-3 py-2 active:opacity-70">
          <Text className="text-[12px] font-ryco-bold text-accent">
            Show {hidden} more line{hidden === 1 ? "" : "s"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ChangeFileCard(props: {
  readonly change: ChangeFile;
  readonly startsCollapsed: boolean;
  readonly scope: GitLocalChangesScope;
  readonly busy: boolean;
  readonly onApply: (selection: { fileId: string; hunkIndex?: number }) => void;
}) {
  const { change, scope } = props;
  const [collapsed, setCollapsed] = useState(props.startsCollapsed);
  const verb = stageVerb(scope);
  const fileId = change.id;
  return (
    <View className="overflow-hidden rounded-[18px] bg-card">
      <View className="flex-row items-center gap-2 py-2.5 pl-4 pr-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${change.file.path}, ${collapsed ? "show" : "hide"} changes`}
          onPress={() => setCollapsed((value) => !value)}
          className="min-w-0 flex-1 active:opacity-70"
        >
          <Text className="font-mono text-[12px] text-foreground" numberOfLines={1}>
            {change.file.path}
          </Text>
          <Text className="mt-0.5 text-[11px] font-ryco-medium text-foreground-muted">
            {change.file.status} ·{" "}
            {formatPullRequestDiffStat(change.file.additions, change.file.deletions)}
            {change.file.previousPath ? ` · from ${change.file.previousPath}` : ""}
          </Text>
        </Pressable>
        {fileId && change.fileAction ? (
          <PillButton
            label={verb}
            variant="quiet"
            disabled={props.busy}
            onPress={() => props.onApply({ fileId })}
            className="h-8 px-3"
          />
        ) : null}
      </View>
      {collapsed ? null : change.file.binary ? (
        <Text className="border-t border-separator px-4 py-3 text-[12px] text-foreground-muted">
          Binary file
        </Text>
      ) : (
        change.hunks.map((hunk) => (
          <HunkBlock
            key={hunk.index}
            hunk={hunk}
            verb={verb}
            canAct={fileId !== null && change.hunkAction && !props.busy}
            onAct={() => {
              if (fileId) props.onApply({ fileId, hunkIndex: hunk.index });
            }}
          />
        ))
      )}
    </View>
  );
}

/**
 * Stage and unstage whole files or single hunks of the checkout, then commit
 * exactly what is staged with an own message. Every write is bound to the
 * revision the review was read at, so a stale screen never stages the wrong lines.
 */
export function SourceControlChangesRouteScreen(props: ChangesRouteProps) {
  const target = useSourceControlTarget(props.route.params);
  const { environmentId, cwd, mutable } = target;
  const { controller, state } = useLocalChangesController(environmentId, cwd);
  const [scope, setScope] = useState<GitLocalChangesScope>("unstaged");
  const [message, setMessage] = useState("");
  const liveData = state ? state.data : null;
  // The last review kept on this device shows while the controller reads; every
  // write still waits for (and is bound to) the controller's own live read.
  const saved = useSavedMirror(localChangesMirror, { environmentId, cwd }, liveData);
  const data = liveData ?? (state?.error ? null : saved.data);
  const files = useMemo(() => buildChangeFiles(data, scope), [data, scope]);
  const counts = useMemo(() => changeCounts(data), [data]);
  const busy = state
    ? state.isApplying || state.isCommitting || state.isLoading || liveData === null
    : true;
  const stagedOnly = target.capabilities?.stagedOnlyCommit === true;

  if (!environmentId || !cwd || !controller) {
    return (
      <View className="flex-1 bg-screen px-5 py-16">
        <EmptyState variant="plain" title="Workspace unavailable" detail="Reconnect and retry." />
      </View>
    );
  }

  const apply = (selection: { fileId: string; hunkIndex?: number }) =>
    void controller.apply({ scope, ...selection });

  const commit = () =>
    void controller
      .commitStaged((input) => commitStaged(environmentId, input), message)
      .then((committed) => {
        if (committed) setMessage("");
      });

  return (
    <View className="flex-1 bg-screen">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={false} onRefresh={() => void controller.refresh()} />
        }
        className="flex-1 bg-screen"
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 64 }}
      >
        <SegmentedControl
          value={scope}
          onChange={setScope}
          options={[
            { value: "unstaged", label: "Unstaged", count: counts.unstaged },
            { value: "staged", label: "Staged", count: counts.staged },
          ]}
        />
        {state?.error ? <ErrorBanner message={state.error} /> : null}
        {!mutable ? (
          <ErrorBanner message={`${target.environmentLabel} is not ready for Git changes.`} />
        ) : null}

        {scope === "staged" && stagedOnly && counts.staged > 0 ? (
          <View className="gap-2 rounded-[18px] bg-card p-3">
            <ToolTextField
              multiline
              autoCapitalize="sentences"
              autoCorrect
              value={message}
              onChangeText={setMessage}
              editable={!state?.isCommitting}
              placeholder="Commit message (blank: generate)"
              accessibilityLabel="Commit message"
              className="min-h-[72px] bg-screen"
              style={{ textAlignVertical: "top" }}
            />
            {state?.commitError ? <ErrorBanner message={state.commitError} /> : null}
            <PillButton
              label="Commit staged"
              symbol="checkmark"
              busy={state?.isCommitting === true}
              disabled={!mutable || busy || !data?.stagedRevision}
              onPress={commit}
            />
            <Text className="px-1 text-[11px] leading-4 text-foreground-muted">
              Records exactly these staged changes; unstaged edits stay in your working files.
            </Text>
          </View>
        ) : null}

        {!data && state?.isLoading !== false ? <LoadingRow label="Reading changes…" /> : null}
        {data && files.length === 0 ? (
          <EmptyState
            variant="plain"
            title={scope === "staged" ? "Nothing staged" : "No unstaged changes"}
            detail={
              scope === "staged"
                ? "Stage files or hunks from Unstaged to commit only those."
                : "Every change in this checkout is staged."
            }
          />
        ) : null}
        {files.map((change, index) => (
          <ChangeFileCard
            // Files are keyed by position: a path can appear twice in a rename pair.
            key={`${scope}:${index}:${change.file.path}`}
            change={change}
            startsCollapsed={changeFileStartsCollapsed(index, change.file)}
            scope={scope}
            busy={busy || !mutable}
            onApply={apply}
          />
        ))}
      </ScrollView>
      {state?.isLoading && data !== null ? <LoadingStrip /> : null}
    </View>
  );
}
