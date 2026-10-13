import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, View } from "react-native";

import type { VcsStatusResult } from "@ryco/contracts";
import { EnvironmentId, ProjectId } from "@ryco/contracts/base-schemas";
import { WorktreeId } from "@ryco/contracts/worktree";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ensureEnvironmentApi, readEnvironmentApi } from "../../connection/environmentApi";
import { uuidv4 } from "../../lib/uuid";
import { useHomeWorkspaceData } from "../../state/homeData";
import { useHomeEnvironments } from "../home/useHomeEnvironments";
import { sourceControlActionAvailability, sourceControlStatusLine } from "./sourceControlModel";

type SourceControlRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId: string;
  readonly worktreeId?: string;
}>;

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function ActionButton(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      className="h-12 items-center justify-center rounded-full bg-primary px-5 active:opacity-80 disabled:opacity-35"
    >
      <Text className="text-sm font-ryco-bold text-primary-foreground">{props.label}</Text>
    </Pressable>
  );
}

export function SourceControlRouteScreen(props: SourceControlRouteProps) {
  const navigation = useNavigation();
  const environmentIdRaw = firstParam(props.route.params.environmentId);
  const projectIdRaw = firstParam(props.route.params.projectId);
  const worktreeIdRaw = firstParam(props.route.params.worktreeId);
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const projectId = projectIdRaw ? ProjectId.make(projectIdRaw) : null;
  const worktreeId = worktreeIdRaw ? WorktreeId.make(worktreeIdRaw) : null;
  const { projects, worktrees } = useHomeWorkspaceData();
  const environments = useHomeEnvironments();
  const project = projects.find(
    (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
  );
  const worktree = worktreeId
    ? worktrees.find(
        (candidate) =>
          candidate.environmentId === environmentId &&
          candidate.projectId === projectId &&
          candidate.id === worktreeId,
      )
    : null;
  const environment = environments.find((candidate) => candidate.environmentId === environmentId);
  const cwd = worktree?.worktreePath ?? project?.cwd ?? null;
  const [status, setStatus] = useState<VcsStatusResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mutable = environment?.mutationReady === true;
  const availability = useMemo(
    () => sourceControlActionAvailability(status, mutable),
    [mutable, status],
  );

  const refresh = async () => {
    if (!environmentId || !cwd) return;
    setError(null);
    try {
      setStatus(await ensureEnvironmentApi(environmentId).vcs.refreshStatus({ cwd }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Source Control could not be refreshed.");
    }
  };

  useEffect(() => {
    if (!environmentId || !cwd) return;
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      setError(`Node ${environment?.label ?? environmentId} is not connected.`);
      return;
    }
    void refresh();
    return api.vcs.onStatus({ cwd }, setStatus, {
      onResubscribe: () => void refresh(),
    });
    // The exact environment and node-owned cwd define the subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, environment?.label, environmentId, mutable]);

  useEffect(() => {
    navigation.setOptions({ title: worktree?.title?.trim() || "Source Control" });
  }, [navigation, worktree?.title]);

  const runAction = async (label: string, action: "commit" | "push" | "commit_push_pr") => {
    if (!environmentId || !cwd) return;
    setBusy(label);
    setError(null);
    try {
      const result = await ensureEnvironmentApi(environmentId).git.runStackedAction({
        actionId: uuidv4(),
        cwd,
        action,
        ...(worktreeId ? { worktreeId } : {}),
        ...(action === "commit_push_pr" ? { featureBranch: true } : {}),
      });
      await refresh();
      Alert.alert(result.toast.title, result.toast.description);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `${label} failed.`);
    } finally {
      setBusy(null);
    }
  };

  const pull = async () => {
    if (!environmentId || !cwd) return;
    setBusy("Pull");
    setError(null);
    try {
      await ensureEnvironmentApi(environmentId).vcs.pull({ cwd });
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Pull failed.");
    } finally {
      setBusy(null);
    }
  };

  if (!environmentId || !projectId || !cwd) {
    return (
      <View className="flex-1 bg-screen px-5 py-16">
        <EmptyState
          variant="plain"
          title="Workspace unavailable"
          detail="The selected node has not published this checkout yet."
        />
      </View>
    );
  }

  const files = [
    ...(status?.workingTree.files ?? []).map((file) => ({
      path: file.path,
      insertions: file.insertions,
      deletions: file.deletions,
      category: "Uncommitted",
    })),
    ...(status?.committed?.files ?? []).map((file) => ({
      path: file.path,
      insertions: file.insertions,
      deletions: file.deletions,
      category: "Committed",
    })),
  ];

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={
        <RefreshControl refreshing={busy === "Refresh"} onRefresh={() => void refresh()} />
      }
      className="flex-1 bg-screen"
      contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 48 }}
    >
      {error ? <ErrorBanner message={error} /> : null}
      {!mutable ? (
        <ErrorBanner
          message={`Node ${environment?.label ?? environmentId} is not ready for Git changes.`}
        />
      ) : null}

      <View className="rounded-[22px] bg-card p-5">
        <Text className="text-xs font-ryco-bold uppercase tracking-wide text-foreground-muted">
          {environment?.label ?? "Node"}
        </Text>
        <Text className="mt-2 text-lg font-ryco-bold text-foreground">
          {project?.name ?? "Project"}
        </Text>
        <Text className="mt-1 font-mono text-xs text-foreground-muted" selectable>
          {cwd}
        </Text>
        <Text className="mt-3 text-sm font-ryco-medium text-foreground">
          {sourceControlStatusLine(status)}
        </Text>
      </View>

      <View className="flex-row flex-wrap gap-2">
        <ActionButton
          label={busy === "Pull" ? "Pulling…" : "Pull"}
          disabled={!availability.canPull || busy !== null}
          onPress={() => void pull()}
        />
        <ActionButton
          label={busy === "Commit" ? "Committing…" : "Commit"}
          disabled={!availability.canCommit || busy !== null}
          onPress={() => void runAction("Commit", "commit")}
        />
        <ActionButton
          label={busy === "Push" ? "Pushing…" : "Push"}
          disabled={!availability.canPush || busy !== null}
          onPress={() => void runAction("Push", "push")}
        />
        <ActionButton
          label={busy === "Create pull request" ? "Creating PR…" : "Create pull request"}
          disabled={!availability.canCreatePullRequest || busy !== null}
          onPress={() => void runAction("Create pull request", "commit_push_pr")}
        />
      </View>

      {status?.pr ? (
        <View className="rounded-2xl bg-card p-4">
          <Text className="text-xs font-ryco-bold uppercase tracking-wide text-foreground-muted">
            Pull request #{status.pr.number} · {status.pr.state}
          </Text>
          <Text className="mt-2 text-base font-ryco-bold text-foreground">{status.pr.title}</Text>
          <Text className="mt-1 text-xs text-foreground-muted">
            {status.pr.headRef} → {status.pr.baseRef}
          </Text>
        </View>
      ) : null}

      <View className="gap-2">
        <Text className="px-1 text-sm font-ryco-bold text-foreground-muted">
          Changes ({files.length})
        </Text>
        {files.map((file) => (
          <View key={`${file.category}:${file.path}`} className="rounded-2xl bg-card px-4 py-3">
            <Text className="font-mono text-xs text-foreground" selectable>
              {file.path}
            </Text>
            <Text className="mt-1 text-xs font-ryco-medium text-foreground-muted">
              {file.category} · +{file.insertions} −{file.deletions}
            </Text>
          </View>
        ))}
        {status && files.length === 0 ? (
          <EmptyState
            variant="card"
            title="Working tree clean"
            detail="There are no changed files."
          />
        ) : null}
      </View>
    </ScrollView>
  );
}
