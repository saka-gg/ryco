import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { errorMessageOr } from "../../lib/errorMessage";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ensureEnvironmentApi } from "../../connection/environmentApi";
import { uuidv4 } from "../../lib/uuid";
import { useThemeColor } from "../../lib/useThemeColor";
import { confirmDefaultBranchAction } from "./defaultBranchPrompt";
import { repositorySetupStep } from "./gitToolsModel";
import { GroupCard, PillButton, SectionTitle, ToolRow } from "./gitToolsParts";
import { sourceControlActionAvailability, sourceControlSyncLine } from "./sourceControlModel";
import {
  useSourceControlTarget,
  useVcsStatus,
  type SourceControlRouteParams,
} from "./useSourceControlTarget";

type SourceControlRouteProps = StaticScreenProps<SourceControlRouteParams>;

function changedFileCount(files: ReadonlyArray<unknown> | undefined): number {
  return files ? files.length : 0;
}

/**
 * A checkout's Git home: the branch (tap to switch or create one), pull, push
 * and commit with a message, staging, comparing with another ref, and the
 * first-run steps (initialise Git, publish to a host).
 */
export function SourceControlRouteScreen(props: SourceControlRouteProps) {
  const navigation = useNavigation();
  const target = useSourceControlTarget(props.route.params);
  const { environmentId, cwd, routeParams, mutable } = target;
  const { status, error: statusError, connected, refresh } = useVcsStatus(target);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const iconColor = useThemeColor("--color-icon");
  const availability = useMemo(
    () => sourceControlActionAvailability(status, mutable),
    [mutable, status],
  );
  const setupStep = repositorySetupStep(status);

  useEffect(() => {
    navigation.setOptions({ title: target.worktree?.title?.trim() || "Source Control" });
  }, [navigation, target.worktree?.title]);

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await work();
      await refresh();
    } catch (cause) {
      setError(errorMessageOr(cause, `${label} failed.`));
    } finally {
      setBusy(null);
    }
  };

  const push = async () => {
    const choice = await confirmDefaultBranchAction({
      action: "push",
      status,
      includesCommit: false,
    });
    if (choice === "cancel") return;
    await run("Push", async () => {
      if (!environmentId || !cwd) return;
      const result = await ensureEnvironmentApi(environmentId).git.runStackedAction({
        actionId: uuidv4(),
        cwd,
        action: "push",
        ...(choice === "feature" ? { featureBranch: true } : {}),
        ...(target.worktreeId ? { worktreeId: target.worktreeId } : {}),
      });
      Alert.alert(result.toast.title, result.toast.description);
    });
  };

  const createPullRequest = async () => {
    const choice = await confirmDefaultBranchAction({
      action: "commit_push_pr",
      status,
      includesCommit: status?.hasWorkingTreeChanges === true,
    });
    if (choice === "cancel") return;
    await run("Create pull request", async () => {
      if (!environmentId || !cwd) return;
      const result = await ensureEnvironmentApi(environmentId).git.runStackedAction({
        actionId: uuidv4(),
        cwd,
        action: "commit_push_pr",
        ...(choice === "feature" ? { featureBranch: true } : {}),
        ...(target.worktreeId ? { worktreeId: target.worktreeId } : {}),
      });
      Alert.alert(result.toast.title, result.toast.description);
    });
  };

  const pull = () =>
    run("Pull", async () => {
      if (!environmentId || !cwd) return;
      await ensureEnvironmentApi(environmentId).vcs.pull({ cwd });
    });

  const initialize = () =>
    run("Initialize Git", async () => {
      if (!environmentId || !cwd) return;
      await ensureEnvironmentApi(environmentId).vcs.init({ cwd });
    });

  if (!environmentId || !routeParams || !cwd) {
    return (
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1 bg-screen"
        contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 48 }}
      >
        <EmptyState
          variant="plain"
          title={target.worktreeMissing ? "Worktree unavailable" : "Workspace unavailable"}
          detail={
            target.worktreeMissing
              ? "This worktree has not loaded on this device yet. Reconnect and try again."
              : "The selected node has not published this checkout yet."
          }
        />
      </ScrollView>
    );
  }

  const uncommitted = changedFileCount(status?.workingTree.files);
  const committed = changedFileCount(status?.committed?.files);
  const isRepo = status?.isRepo === true;
  const shownError = error ?? statusError;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={false} onRefresh={() => void refresh()} />}
      className="flex-1 bg-screen"
      contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 48 }}
    >
      {shownError ? <ErrorBanner message={shownError} /> : null}
      {!connected ? (
        <ErrorBanner message={`${target.environmentLabel} is not connected.`} />
      ) : !mutable ? (
        <ErrorBanner message={`${target.environmentLabel} is not ready for Git changes.`} />
      ) : null}

      <View className="gap-3 rounded-[22px] bg-card p-5">
        <View>
          <Text className="text-xs font-ryco-bold uppercase tracking-wide text-foreground-muted">
            {target.environmentLabel}
          </Text>
          <Text className="mt-1.5 text-lg font-ryco-bold text-foreground">
            {target.project?.name ?? "Project"}
          </Text>
          <Text className="mt-0.5 font-mono text-[11px] text-foreground-muted" selectable>
            {cwd}
          </Text>
        </View>
        {isRepo ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Branch ${status?.refName ?? "detached"}. Switch or create a branch`}
            onPress={() => navigation.navigate("ProjectBranches", routeParams)}
            className="flex-row items-center gap-2 self-start rounded-full bg-subtle-strong px-3.5 py-2 active:opacity-70"
          >
            <SymbolView
              name="arrow.triangle.branch"
              size={13}
              tintColor={iconColor as string}
              type="monochrome"
            />
            <Text className="max-w-[240px] font-mono text-[13px] text-foreground" numberOfLines={1}>
              {status?.refName ?? "Detached HEAD"}
            </Text>
            <SymbolView
              name="chevron.down"
              size={10}
              tintColor={iconColor as string}
              type="monochrome"
            />
          </Pressable>
        ) : null}
        <Text className="text-sm font-ryco-medium text-foreground-secondary">
          {sourceControlSyncLine(status)}
        </Text>
      </View>

      {setupStep === "initialize" ? (
        <GroupCard>
          <View className="gap-3 p-4">
            <Text className="text-[15px] font-ryco-bold text-foreground">No Git repository</Text>
            <Text className="text-[13px] leading-5 text-foreground-muted">
              Initialize Git in this folder to track changes, commit and publish it.
            </Text>
            <PillButton
              label="Initialize Git"
              symbol="plus"
              busy={busy === "Initialize Git"}
              disabled={!mutable || busy !== null}
              onPress={() => void initialize()}
              className="self-start"
            />
          </View>
        </GroupCard>
      ) : null}

      {isRepo ? (
        <View className="flex-row gap-2">
          <PillButton
            label="Pull"
            symbol="arrow.down"
            variant="quiet"
            className="flex-1"
            busy={busy === "Pull"}
            disabled={!availability.canPull || busy !== null}
            onPress={() => void pull()}
          />
          <PillButton
            label="Push"
            symbol="arrow.up"
            variant="quiet"
            className="flex-1"
            busy={busy === "Push"}
            disabled={!availability.canPush || busy !== null}
            onPress={() => void push()}
          />
          <PillButton
            label="Commit"
            symbol="checkmark"
            className="flex-1"
            disabled={!availability.canCommit || busy !== null}
            onPress={() => navigation.navigate("ProjectCommit", routeParams)}
          />
        </View>
      ) : null}

      {isRepo ? (
        <View>
          <SectionTitle>Changes</SectionTitle>
          <GroupCard>
            <ToolRow
              first
              symbol="square.and.pencil"
              title="Review & stage"
              detail={
                uncommitted > 0
                  ? `${uncommitted} uncommitted file${uncommitted === 1 ? "" : "s"} · stage files or hunks`
                  : "Working tree clean"
              }
              onPress={() => navigation.navigate("ProjectChanges", routeParams)}
            />
            <ToolRow
              symbol="square.split.2x1"
              title="Compare"
              detail={
                committed > 0
                  ? `${committed} file${committed === 1 ? "" : "s"} changed on this branch · blame lines`
                  : "Diff against another branch, tag or commit"
              }
              onPress={() => navigation.navigate("ProjectCompare", routeParams)}
            />
            {setupStep === "publish" ? (
              <ToolRow
                symbol="square.and.arrow.up"
                title="Publish repository"
                detail="Create it on GitHub, GitLab or another host and push"
                disabled={!mutable}
                onPress={() => navigation.navigate("ProjectPublish", routeParams)}
              />
            ) : null}
          </GroupCard>
        </View>
      ) : null}

      {isRepo && setupStep === null ? (
        <View>
          <SectionTitle>Pull request</SectionTitle>
          <GroupCard>
            {status?.pr ? (
              <ToolRow
                first
                symbol="arrow.triangle.pull"
                title={`#${status.pr.number} ${status.pr.title}`}
                detail={`${status.pr.state} · ${status.pr.headRef} → ${status.pr.baseRef}`}
                onPress={() =>
                  navigation.navigate("ProjectPullRequest", {
                    environmentId: routeParams.environmentId,
                    projectId: routeParams.projectId,
                    number: String(status.pr?.number ?? ""),
                  })
                }
              />
            ) : (
              <ToolRow
                first
                symbol="arrow.triangle.pull"
                title={
                  busy === "Create pull request" ? "Creating pull request…" : "Create pull request"
                }
                detail="Commits, pushes and opens one for this branch"
                disabled={!availability.canCreatePullRequest || busy !== null}
                onPress={() => void createPullRequest()}
              />
            )}
            <ToolRow
              symbol="list.clipboard"
              title="All pull requests"
              onPress={() =>
                navigation.navigate("ProjectPullRequests", {
                  environmentId: routeParams.environmentId,
                  projectId: routeParams.projectId,
                })
              }
            />
          </GroupCard>
        </View>
      ) : null}

      {status && uncommitted + committed > 0 ? (
        <View>
          <SectionTitle>Files</SectionTitle>
          <GroupCard>
            {[
              ...status.workingTree.files.map((file) => ({ ...file, category: "Uncommitted" })),
              ...(status.committed?.files ?? []).map((file) => ({
                ...file,
                category: "Committed",
              })),
            ].map((file, index) => (
              <View
                key={`${file.category}:${file.path}`}
                className={`px-4 py-2.5 ${index === 0 ? "" : "border-t border-separator"}`}
              >
                <Text
                  className="font-mono text-[12px] text-foreground"
                  numberOfLines={1}
                  selectable
                >
                  {file.path}
                </Text>
                <Text className="mt-0.5 text-[11px] font-ryco-medium text-foreground-muted">
                  {file.category} ·{" "}
                  <Text className="text-[11px] text-diff-add">+{file.insertions}</Text>{" "}
                  <Text className="text-[11px] text-diff-del">−{file.deletions}</Text>
                </Text>
              </View>
            ))}
          </GroupCard>
        </View>
      ) : null}
    </ScrollView>
  );
}
