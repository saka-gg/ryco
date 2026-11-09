import { StackActions, type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  advancePromotionStepsAfterMove,
  BUSY_CHAT_REASON,
  chatActivitySignature,
  chatConversationContinuity,
  chatThreadLiveWork,
  DESTINATION_PREVIEW_DEBOUNCE_MS,
  describeChatBusy,
  describeConversationContinuity,
  describeDestinationStatus,
  describeGitPlan,
  describeMovePlan,
  describePromotionError,
  describePromotionUnavailable,
  effectiveGitOptions,
  initialDestinationForName,
  isLocationFailure,
  planPromotionSteps,
  PROMOTION_SUCCESS_HOLD_MS,
  promotionErrorStillApplies,
  promotionHasWarnings,
  resolveNextTurnProviderDriver,
  resolvePromotionSteps,
  resolvePromotionSubmitBlocker,
  retargetDestinationForName,
  shouldShowGitIdentityNotice,
  type DestinationStatusTone,
  type PromotionErrorPresentation,
  type PromotionGitOptions,
  type PromotionStep,
} from "@ryco/client-runtime/state/chats";
import {
  isArchivedThreadStub,
  type SidebarThreadSummary,
} from "@ryco/client-runtime/state/threads";
import { EnvironmentId, ThreadId } from "@ryco/contracts/base-schemas";
import { WS_METHODS } from "@ryco/contracts/rpc";
import { isChatProject } from "@ryco/shared/projectKind";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Switch, TextInput, View } from "react-native";
import { useShallow } from "zustand/react/shallow";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { nodeMethodBlockReason } from "../../connection/nodeRoleAccess";
import { useEnvironmentApi } from "../../connection/useEnvironmentApi";
import { useThemeColor } from "../../lib/useThemeColor";
import { useEnvironmentServerConfigs } from "../../state/environmentServerConfigs";
import {
  selectProjectByRef,
  selectSidebarThreadsForProjectRef,
  selectThreadByRef,
  useStore,
} from "../../state/threadsRuntime";
import { useHomeEnvironments } from "../home/useHomeEnvironments";
import { interruptThreadTurn } from "../threads/sessionActions";
import {
  findFreeDestination,
  freeDestinationCandidates,
  previewForDestination,
  type PromoteChatPreviewAnswer,
} from "./promoteChatModel";

type PromoteChatRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

const TONE_CLASS: Record<DestinationStatusTone, string> = {
  positive: "text-success",
  caution: "text-warning",
  negative: "text-danger",
  neutral: "text-foreground-muted",
};

const STEP_SYMBOL: Record<PromotionStep["status"], string> = {
  pending: "circle",
  running: "circle.dotted",
  done: "checkmark.circle.fill",
  skipped: "minus.circle",
  warning: "exclamationmark.triangle.fill",
};

type Phase =
  | { readonly kind: "edit" }
  | { readonly kind: "running"; readonly steps: ReadonlyArray<PromotionStep> }
  | { readonly kind: "done"; readonly steps: ReadonlyArray<PromotionStep> };

/**
 * "Turn into project": a chat without a project moves to a folder of its own and becomes a
 * project, optionally with Git. Every rule (where it may go, what happens, each server verdict)
 * is the shared one web's dialog reads (`@ryco/client-runtime/state/chats`); this screen only
 * asks the node and lays it out.
 */
export function PromoteChatRouteScreen(props: PromoteChatRouteScreenProps) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const threadId = ThreadId.make(props.route.params.threadId);
  const textColor = useThemeColor("--color-foreground") as string;
  const placeholderColor = useThemeColor("--color-placeholder") as string;
  const iconColor = useThemeColor("--color-icon") as string;

  const thread = useStore((state) =>
    selectThreadByRef(state, scopeThreadRef(environmentId, threadId)),
  );
  const projectId = thread?.projectId ?? null;
  const project = useStore((state) =>
    projectId ? selectProjectByRef(state, scopeProjectRef(environmentId, projectId)) : undefined,
  );
  const chatThreads = useStore(
    useShallow((state) =>
      projectId
        ? selectSidebarThreadsForProjectRef(state, scopeProjectRef(environmentId, projectId))
        : [],
    ),
  );
  const liveThreads = useMemo(
    () =>
      chatThreads.filter(
        (candidate): candidate is SidebarThreadSummary => !isArchivedThreadStub(candidate),
      ),
    [chatThreads],
  );
  const providers = useEnvironmentServerConfigs().get(environmentId)?.providers ?? [];
  const environmentRow = useHomeEnvironments().find(
    (candidate) => candidate.environmentId === environmentId,
  );
  // The node's own access rule for the move, on a connection whose writes are synchronized.
  const accessBlock = environmentRow
    ? nodeMethodBlockReason(
        environmentRow,
        WS_METHODS.projectsPromoteChat,
        "turn chats into projects",
      )
    : "Reconnect the machine to turn chats into projects.";

  const [name, setName] = useState(() => (project?.name ?? thread?.title ?? "").trim());
  const [destination, setDestination] = useState("");
  const [git, setGit] = useState<PromotionGitOptions>({
    initializeGit: true,
    initialCommit: true,
    writeGitignore: true,
  });
  const [answer, setAnswer] = useState<PromoteChatPreviewAnswer | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    readonly presentation: PromotionErrorPresentation;
    readonly destination: string | null;
  } | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "edit" });
  const [stopping, setStopping] = useState(false);

  const api = useEnvironmentApi(projectId ? environmentId : null);
  const previewApi = api?.projects.promoteChatPreview;

  // The default location, once: the node's free folder for this chat, renamed for its name.
  const defaultsLoaded = useRef(false);
  useEffect(() => {
    if (defaultsLoaded.current || !previewApi || !projectId) return;
    defaultsLoaded.current = true;
    void previewApi({ projectId })
      .then((result) => {
        setDestination((current) =>
          current.trim().length > 0
            ? current
            : initialDestinationForName(result.defaultDestination, name),
        );
      })
      .catch((cause: unknown) =>
        setFailure({ presentation: describePromotionError(cause), destination: null }),
      );
  }, [name, previewApi, projectId]);

  // The live check of the typed location, debounced; it re-runs when the chat's work changes,
  // so a busy notice clears itself once the agent stops.
  const activitySignature = chatActivitySignature(chatThreadLiveWork(liveThreads, () => 0));
  const trimmedDestination = destination.trim();
  useEffect(() => {
    if (!previewApi || !projectId || trimmedDestination.length === 0) return;
    let current = true;
    const timer = setTimeout(() => {
      void previewApi({ projectId, destination: trimmedDestination })
        .then((result) => {
          if (current) setAnswer({ destination: trimmedDestination, result });
        })
        .catch((cause: unknown) => {
          if (current) {
            setFailure({ presentation: describePromotionError(cause), destination: null });
          }
        });
    }, DESTINATION_PREVIEW_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [activitySignature, previewApi, previewRevision, projectId, trimmedDestination]);

  const preview = previewForDestination(answer, destination);
  const destinationState =
    trimmedDestination.length === 0 ? "empty" : (preview?.destinationStatus ?? "checking");

  // A taken folder: offer the next free sibling name.
  useEffect(() => {
    setSuggestion(null);
    if (!previewApi || !projectId || preview?.destinationStatus !== "exists") return;
    let cancelled = false;
    void findFreeDestination({
      candidates: freeDestinationCandidates(trimmedDestination),
      preview: (candidate) => previewApi({ projectId, destination: candidate }),
      cancelled: () => cancelled,
    }).then((free) => {
      if (!cancelled) setSuggestion(free);
    });
    return () => {
      cancelled = true;
    };
  }, [preview?.destinationStatus, previewApi, projectId, trimmedDestination]);

  const busy = preview
    ? describeChatBusy({
        busyThreadIds: preview.busyThreadIds,
        work: chatThreadLiveWork(liveThreads, () => 0),
      })
    : null;
  const effectiveGit = effectiveGitOptions(git, preview?.gitAvailable ?? true);
  const blocker = resolvePromotionSubmitBlocker({ name, destination, preview });
  const shownFailure =
    failure &&
    promotionErrorStillApplies({
      failure: failure.presentation,
      failedDestination: failure.destination,
      destination: trimmedDestination,
    })
      ? failure.presentation
      : null;

  const changeName = (next: string) => {
    setDestination((current) =>
      retargetDestinationForName({ destination: current, previousName: name, nextName: next }),
    );
    setName(next);
  };

  const finish = () => navigation.dispatch(StackActions.pop());

  const submit = () => {
    const promoteChat = api?.projects.promoteChat;
    if (!promoteChat || !projectId || !preview || blocker !== null || accessBlock !== null) return;
    const submitted = trimmedDestination;
    setFailure(null);
    setPhase({ kind: "running", steps: planPromotionSteps(effectiveGit, preview) });
    void promoteChat({
      projectId,
      ...(project?.updatedAt ? { expectedUpdatedAt: project.updatedAt } : {}),
      title: name.trim(),
      destination: submitted,
      ...effectiveGit,
    })
      .then((result) => {
        const steps = resolvePromotionSteps(effectiveGit, result);
        setPhase({ kind: "done", steps });
        if (!promotionHasWarnings(steps)) setTimeout(finish, PROMOTION_SUCCESS_HOLD_MS);
      })
      .catch((cause: unknown) => {
        const presentation = describePromotionError(cause);
        setFailure({ presentation, destination: submitted });
        setPhase({ kind: "edit" });
        if (presentation.recovery === "refresh-preview" || isLocationFailure(presentation)) {
          setPreviewRevision((value) => value + 1);
        }
      });
  };

  const stopAgents = (threadIds: ReadonlyArray<ThreadId>) => {
    if (!api) return;
    setStopping(true);
    void Promise.allSettled(threadIds.map((id) => interruptThreadTurn(api, id))).then(() => {
      setStopping(false);
      setPreviewRevision((value) => value + 1);
    });
  };

  // While and after it moves, the project is no longer a chat: the steps stay on screen.
  if (phase.kind !== "edit") {
    const warnings = phase.kind === "done" && promotionHasWarnings(phase.steps);
    // The node re-points the project before it sets up Git, and the stream can say so before
    // the request answers: the move then shows as done.
    const steps =
      phase.kind === "running" && project && !isChatProject(project)
        ? advancePromotionStepsAfterMove(phase.steps, project.cwd)
        : phase.steps;
    return (
      <ScrollView
        className="flex-1 bg-screen"
        contentContainerStyle={{ padding: 20, gap: 16 }}
        contentInsetAdjustmentBehavior="automatic"
      >
        <Text className="text-xl font-ryco-bold text-foreground">
          {phase.kind === "running"
            ? "Turning into a project…"
            : warnings
              ? "Project created, with a note"
              : "Project created"}
        </Text>
        <View className="gap-3 rounded-2xl border border-border bg-card p-4">
          {steps.map((step) => (
            <View key={step.id} className="flex-row gap-3">
              {step.status === "running" ? (
                <ActivityIndicator size="small" />
              ) : (
                <SymbolView
                  name={STEP_SYMBOL[step.status] as never}
                  size={18}
                  tintColor={iconColor}
                  type="monochrome"
                />
              )}
              <View className="min-w-0 flex-1 gap-0.5">
                <Text className="text-base font-ryco-medium text-foreground">{step.label}</Text>
                {step.detail ? (
                  <Text className="text-xs text-foreground-muted" selectable>
                    {step.detail}
                  </Text>
                ) : null}
              </View>
            </View>
          ))}
        </View>
        {phase.kind === "done" && warnings ? (
          <Pressable
            accessibilityRole="button"
            onPress={finish}
            className="h-12 items-center justify-center rounded-full bg-primary px-5 active:opacity-80"
          >
            <Text className="text-base font-ryco-bold text-primary-foreground">Done</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    );
  }
  if (!thread || !project || !isChatProject(project)) {
    return (
      <View className="flex-1 bg-screen p-5">
        <EmptyState
          variant="plain"
          title={project && !isChatProject(project) ? "Already a project" : "Chat not found"}
          detail={
            project && !isChatProject(project)
              ? "This chat already lives in a project."
              : "It may have been deleted on another device."
          }
        />
      </View>
    );
  }
  if (!previewApi) {
    const unavailable = describePromotionUnavailable();
    return (
      <View className="flex-1 bg-screen p-5">
        <EmptyState variant="plain" title={unavailable.title} detail={unavailable.message} />
      </View>
    );
  }

  const status = describeDestinationStatus(destinationState);
  const movePlan = preview ? describeMovePlan(preview) : null;
  const gitPlan = describeGitPlan(effectiveGit, preview?.gitAvailable ?? true);
  const continuity = describeConversationContinuity(
    chatConversationContinuity(
      liveThreads.map((candidate) => resolveNextTurnProviderDriver(candidate, providers)),
    ),
  );

  return (
    <ScrollView
      className="flex-1 bg-screen"
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 20, gap: 18, paddingBottom: 56 }}
    >
      <Text className="text-sm text-foreground-muted">
        The chat&apos;s folder moves to a place of its own and becomes a project: branches,
        worktrees and checkpoints become available.
      </Text>

      {shownFailure ? (
        <View className="gap-1">
          <ErrorBanner message={`${shownFailure.title}. ${shownFailure.message}`} />
        </View>
      ) : null}

      <View className="gap-2">
        <Text className="px-1 text-sm font-ryco-medium text-foreground-muted">Project name</Text>
        <TextInput
          value={name}
          onChangeText={changeName}
          placeholder="Name"
          placeholderTextColor={placeholderColor}
          className="min-h-14 rounded-2xl border border-border bg-card px-4 py-3 font-sans text-base"
          style={{ color: textColor }}
        />
      </View>

      <View className="gap-2">
        <Text className="px-1 text-sm font-ryco-medium text-foreground-muted">Location</Text>
        <TextInput
          value={destination}
          onChangeText={setDestination}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="/path/to/project"
          placeholderTextColor={placeholderColor}
          className="min-h-14 rounded-2xl border border-border bg-card px-4 py-3 font-mono text-sm"
          style={{ color: textColor }}
        />
        <Text className={`px-1 text-xs ${TONE_CLASS[status.tone]}`}>{status.text}</Text>
        {suggestion ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => setDestination(suggestion)}
            className="self-start rounded-full bg-subtle px-3 py-1.5 active:opacity-70"
          >
            <Text className="text-xs font-ryco-medium text-foreground" numberOfLines={1}>
              Use {suggestion.split(/[\\/]/).at(-1)}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {busy ? (
        <View className="gap-2 rounded-2xl border border-border bg-card p-4">
          <Text className="text-sm font-ryco-bold text-foreground">{busy.title}</Text>
          <Text className="text-xs text-foreground-muted">{busy.message}</Text>
          <View className="flex-row gap-2">
            {busy.stoppableThreadIds.length > 0 ? (
              <Pressable
                accessibilityRole="button"
                disabled={stopping}
                onPress={() => stopAgents(busy.stoppableThreadIds)}
                className="rounded-full bg-subtle px-3 py-1.5 active:opacity-70 disabled:opacity-40"
              >
                <Text className="text-xs font-ryco-medium text-foreground">Stop the agent</Text>
              </Pressable>
            ) : null}
            {busy.offerRecheck ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setPreviewRevision((value) => value + 1)}
                className="rounded-full bg-subtle px-3 py-1.5 active:opacity-70"
              >
                <Text className="text-xs font-ryco-medium text-foreground">Check again</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}

      <View className="gap-3 rounded-2xl border border-border bg-card p-4">
        <Text className="text-xs font-ryco-bold uppercase tracking-wide text-foreground-muted">
          What happens
        </Text>
        <PlanLine
          symbol="folder"
          title={movePlan?.title ?? "Checking the chat folder…"}
          detail={movePlan?.detail ?? null}
          iconColor={iconColor}
        />
        <PlanLine
          symbol="bubble.left.and.bubble.right"
          title="The conversation continues"
          detail={continuity}
          iconColor={iconColor}
        />
        <PlanLine
          symbol="arrow.triangle.branch"
          title={gitPlan.title}
          detail={gitPlan.detail}
          iconColor={iconColor}
        />
      </View>

      {preview?.gitAvailable !== false ? (
        <View className="overflow-hidden rounded-2xl border border-border bg-card">
          <GitSwitch
            label="Initialize Git"
            value={git.initializeGit}
            onChange={(initializeGit) => setGit((current) => ({ ...current, initializeGit }))}
            first
          />
          {git.initializeGit ? (
            <>
              <GitSwitch
                label="Add a .gitignore"
                value={git.writeGitignore}
                onChange={(writeGitignore) => setGit((current) => ({ ...current, writeGitignore }))}
              />
              <GitSwitch
                label="Make an initial commit"
                value={git.initialCommit}
                onChange={(initialCommit) => setGit((current) => ({ ...current, initialCommit }))}
              />
            </>
          ) : null}
        </View>
      ) : null}
      {preview &&
      shouldShowGitIdentityNotice({
        gitAvailable: preview.gitAvailable,
        gitIdentityConfigured: preview.gitIdentityConfigured,
        options: git,
      }) ? (
        <Text className="px-1 text-xs text-warning">
          Git has no name or email on this machine yet, so the initial commit will be skipped. Set
          user.name and user.email in its Git config.
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityHint={accessBlock ?? blocker?.reason}
        disabled={blocker !== null || accessBlock !== null}
        onPress={submit}
        className="h-12 items-center justify-center rounded-full bg-primary px-5 active:opacity-80 disabled:opacity-40"
      >
        <Text className="text-base font-ryco-bold text-primary-foreground">Turn into project</Text>
      </Pressable>
      {accessBlock ? (
        <Text className="-mt-2 px-1 text-center text-xs text-foreground-muted">{accessBlock}</Text>
      ) : blocker && blocker.field !== "pending" && blocker.reason !== BUSY_CHAT_REASON ? (
        <Text className="-mt-2 px-1 text-center text-xs text-foreground-muted">
          {blocker.reason}
        </Text>
      ) : null}
    </ScrollView>
  );
}

function PlanLine(props: {
  readonly symbol: string;
  readonly title: string;
  readonly detail: string | null;
  readonly iconColor: string;
}) {
  return (
    <View className="flex-row gap-3">
      <SymbolView
        name={props.symbol as never}
        size={16}
        tintColor={props.iconColor}
        type="monochrome"
      />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-sm font-ryco-medium text-foreground">{props.title}</Text>
        {props.detail ? (
          <Text className="text-xs text-foreground-muted">{props.detail}</Text>
        ) : null}
      </View>
    </View>
  );
}

function GitSwitch(props: {
  readonly label: string;
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
  readonly first?: boolean;
}) {
  return (
    <View
      className={`flex-row items-center gap-3 px-4 py-3 ${props.first ? "" : "border-t border-border-subtle"}`}
    >
      <Text className="min-w-0 flex-1 text-base text-foreground">{props.label}</Text>
      <Switch value={props.value} onValueChange={props.onChange} />
    </View>
  );
}
