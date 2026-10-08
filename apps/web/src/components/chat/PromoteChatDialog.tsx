// FILE: PromoteChatDialog.tsx
// Purpose: "Turn this chat into a project": pick a name and a permanent
//          location, see exactly what will happen (from the server's preview),
//          choose the Git setup, then watch the move settle step by step.
// Layer: Web UI. The app's one instance is mounted lazily by `RootAppShell`
//        and opened through `promoteChatDialogStore.ts`.
// Motion: the dialog grows out of the control that opened it and, once the
//         chat is a project, folds into that project's row in the sidebar
//         (`surfaceMorph.ts`). Everything else rides the house motion tokens,
//         so reduced motion collapses it to instant state changes.

import { scopedProjectKey, scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  CHAT_PROJECT_TITLE_MAX_CHARS,
  type ProjectsPromoteChatPreviewResult,
  type ProjectsPromoteChatResult,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadId,
} from "@ryco/contracts";
import { isChatProject } from "@ryco/shared/projectKind";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useDebouncedValue } from "@tanstack/react-pacer";
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  CheckIcon,
  CircleIcon,
  CopyIcon,
  FolderGit2Icon,
  FolderOpenIcon,
  GitBranchIcon,
  MessageSquareIcon,
  MinusIcon,
} from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { readEnvironmentApi } from "../../environmentApi";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useEvent } from "../../hooks/useEvent";
import { useSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { openFolderWithFeedback } from "../../lib/chatFolderActions";
import {
  getBrowseDirectoryPath,
  getBrowseLeafPathSegment,
  isFilesystemBrowseQuery,
} from "../../lib/projectPaths";
import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { deriveLogicalProjectKeyFromSettings } from "../../logicalProject";
import { useFilesystemBrowse } from "../../rpc/useProject";
import { selectProjectByRef, selectSidebarThreadsForProjectRef, useStore } from "../../store";
import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../../threadRoutes";
import type { Project } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import { filterBrowseEntries } from "../CommandPalette.logic";
import { AnimatedHeight } from "../AnimatedHeight";
import { getEditorLabel } from "../settings/SettingsPanels.editor";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import {
  Autocomplete,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "../ui/autocomplete";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { Input } from "../ui/input";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import type { SurfaceMorph } from "../ui/surfaceMorph";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { RollingText } from "./RollingText";
import {
  closePromoteChatDialog,
  type PromoteChatDialogRequest,
  SIDEBAR_PROJECT_MEMBERS_ATTRIBUTE,
  usePromoteChatDialogStore,
} from "./promoteChatDialogStore";
import {
  chatActivitySignature,
  type ChatBusyPresentation,
  chatThreadLiveWork,
  type DestinationCheckState,
  describeChatBusy,
  describeDestinationStatus,
  describeGitPlan,
  describeMovePlan,
  describePromotionError,
  describePromotionUnavailable,
  DESTINATION_PREVIEW_DEBOUNCE_MS,
  destinationLeaf,
  effectiveGitOptions,
  freeLeafCandidates,
  GIT_IDENTITY_COMMANDS,
  initialDestinationForName,
  isLocationFailure,
  joinDestination,
  planPromotionSteps,
  projectFolderLeafForName,
  PROMOTED_PROJECT_ARRIVAL_TIMEOUT_MS,
  PROMOTION_SUCCESS_HOLD_MS,
  type PromotionErrorPresentation,
  type PromotionStep,
  type PromotionSubmitBlocker,
  promotionErrorStillApplies,
  promotionHasWarnings,
  replaceDestinationLeaf,
  resolvePromotionSteps,
  resolvePromotionSubmitBlocker,
  retargetDestinationForName,
  shouldShowGitIdentityNotice,
} from "./PromoteChatDialog.logic";

const PROMOTE_FORM_ID = "promote-chat-form";
const MAX_FOLDER_SUGGESTIONS = 8;
/** Results reveal one after another, a third of the house "stack" step apart. */
const STEP_STAGGER_FACTOR = 0.35;
/** `--app-motion-duration-stack` at full motion: how long the staggered reveal runs. */
const STACK_STEP_MS = 260;

/**
 * How the dialog answers a close request: close it, ignore it while files
 * move, or — once the chat is a project — finish (open the project, toast)
 * exactly as "Done" does.
 */
type CloseBehavior =
  | { readonly kind: "close" }
  | { readonly kind: "block" }
  | { readonly kind: "finish"; readonly finish: () => void };

const CLOSE_NOW: CloseBehavior = { kind: "close" };
const CLOSE_BLOCKED: CloseBehavior = { kind: "block" };

interface PromotionOutcome {
  readonly projectRef: ScopedProjectRef;
  readonly threadRef: ScopedThreadRef | null;
  readonly workspaceRoot: string;
}

/* ───────── Host ───────── */

/** The app's one promotion dialog. Mount once; open it with `openPromoteChatDialog`. */
export function PromoteChatDialog() {
  const open = usePromoteChatDialogStore((state) => state.open);
  const token = usePromoteChatDialogStore((state) => state.token);
  const request = usePromoteChatDialogStore((state) => state.request);
  const origin = usePromoteChatDialogStore((state) => state.origin);
  const popupRef = useRef<HTMLDivElement | null>(null);
  // The outcome of the open it belongs to: the fold returns to the opener
  // unless this open promoted the chat. Each open's body reports how a close
  // request (Escape, outside press, the close button) is handled as it mounts.
  const outcomeRef = useRef<{ readonly token: number; readonly outcome: PromotionOutcome } | null>(
    null,
  );
  const closeBehaviorRef = useRef<CloseBehavior>(CLOSE_NOW);
  const handleCloseBehaviorChange = useEvent((behavior: CloseBehavior) => {
    closeBehaviorRef.current = behavior;
  });
  const handlePromoted = useEvent((outcome: PromotionOutcome) => {
    outcomeRef.current = { token: usePromoteChatDialogStore.getState().token, outcome };
  });

  const morph: SurfaceMorph = {
    ...(origin ? { origin: () => origin } : {}),
    target: (resolvedOrigin) => {
      const promoted = outcomeRef.current;
      if (!promoted || promoted.token !== usePromoteChatDialogStore.getState().token) {
        return resolvedOrigin?.isConnected ? resolvedOrigin : null;
      }
      return findPromotedProjectRow(promoted.outcome);
    },
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        const behavior = closeBehaviorRef.current;
        if (behavior.kind === "finish") behavior.finish();
        else if (behavior.kind === "close") closePromoteChatDialog();
      }}
    >
      <DialogPopup
        ref={popupRef}
        className="max-w-xl"
        data-testid="promote-chat-dialog"
        bottomStickOnMobile={false}
        morph={morph}
        initialFocus={() =>
          popupRef.current?.querySelector<HTMLElement>("[data-promote-primary]") ?? true
        }
      >
        {request ? (
          <PromoteChatDialogBody
            key={token}
            request={request}
            onCloseBehaviorChange={handleCloseBehaviorChange}
            onPromoted={handlePromoted}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Where a promoted chat now lives in the sidebar: its project row, else its
 * thread row (an Inbox sidebar has no project rows), else nowhere (dissolve).
 */
function findPromotedProjectRow(outcome: PromotionOutcome): HTMLElement | null {
  const projectKey = CSS.escape(scopedProjectKey(outcome.projectRef));
  const projectRow = document.querySelector<HTMLElement>(
    `[${SIDEBAR_PROJECT_MEMBERS_ATTRIBUTE}~="${projectKey}"]`,
  );
  if (projectRow) return projectRow;
  if (!outcome.threadRef) return null;
  return document.querySelector<HTMLElement>(
    `[data-testid="thread-row-${CSS.escape(outcome.threadRef.threadId)}"]`,
  );
}

/**
 * Resolves once the store shows the project as a regular project (the shell
 * stream may deliver the change just before or after the RPC answer), or with
 * whatever the store holds when `timeoutMs` runs out.
 */
function waitForPromotedProject(
  projectRef: ScopedProjectRef,
  timeoutMs: number,
): Promise<Project | null> {
  const read = () => {
    const project = selectProjectByRef(useStore.getState(), projectRef) ?? null;
    return project && !isChatProject(project) ? project : null;
  };
  const settled = read();
  if (settled) return Promise.resolve(settled);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      unsubscribe();
      resolve(read());
    }, timeoutMs);
    const unsubscribe = useStore.subscribe(() => {
      const project = read();
      if (!project) return;
      window.clearTimeout(timer);
      unsubscribe();
      resolve(project);
    });
  });
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

/* ───────── Body ───────── */

type Phase = "editing" | "submitting" | "done";

interface PreviewState {
  /** The destination the server judged (the default one for the first preview). */
  readonly requested: string;
  readonly result: ProjectsPromoteChatPreviewResult;
}

interface FreeNameSuggestion {
  /** The taken destination this suggestion replaces. */
  readonly forDestination: string;
  readonly destination: string;
  readonly leaf: string;
}

function PromoteChatDialogBody(props: {
  readonly request: PromoteChatDialogRequest;
  readonly onCloseBehaviorChange: (behavior: CloseBehavior) => void;
  readonly onPromoted: (outcome: PromotionOutcome) => void;
}) {
  const { request } = props;
  const { projectRef } = request;
  const environmentId = projectRef.environmentId;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isLocalChat = primaryEnvironmentId !== null && environmentId === primaryEnvironmentId;
  const canPickNatively =
    isLocalChat && typeof window !== "undefined" && window.desktopBridge !== undefined;
  const navigate = useNavigate();
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => {
      const target = resolveThreadRouteTarget(params);
      return target?.kind === "server" ? target.threadRef : null;
    },
  });
  const groupingMode = useSettings((settings) => settings.sidebarProjectGroupingMode);
  const groupingOverrides = useSettings((settings) => settings.sidebarProjectGroupingOverrides);
  const { interruptThreadTurn } = useThreadActions();

  const [name, setName] = useState(() => {
    const project = selectProjectByRef(useStore.getState(), projectRef);
    return (request.title ?? project?.name ?? "").trim();
  });
  const [location, setLocation] = useState("");
  const [initializeGit, setInitializeGit] = useState(true);
  const [initialCommit, setInitialCommit] = useState(true);
  const [writeGitignore, setWriteGitignore] = useState(true);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewFailure, setPreviewFailure] = useState<PromotionErrorPresentation | null>(null);
  const [checking, setChecking] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);
  const [suggestion, setSuggestion] = useState<FreeNameSuggestion | null>(null);
  const [phase, setPhase] = useState<Phase>("editing");
  const [steps, setSteps] = useState<ReadonlyArray<PromotionStep>>([]);
  const [submitError, setSubmitError] = useState<PromotionErrorPresentation | null>(null);
  // The location a refused promotion was about; its alert goes once that changes.
  const [submitErrorDestination, setSubmitErrorDestination] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ProjectsPromoteChatResult | null>(null);
  const [formEpoch, setFormEpoch] = useState(0);
  const [stopping, setStopping] = useState(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const locationInputRef = useRef<HTMLInputElement | null>(null);
  const primaryButtonRef = useRef<HTMLButtonElement | null>(null);
  const previewSeqRef = useRef(0);
  const lastPreviewKeyRef = useRef<string | null>(null);
  const finishingRef = useRef(false);
  const holdTimerRef = useRef<number | null>(null);
  const arrivalRef = useRef<Promise<Project | null> | null>(null);

  const { onCloseBehaviorChange, onPromoted } = props;

  useEffect(
    () => () => {
      if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
    },
    [],
  );

  // Live work in the chat, as this client sees it: the agent's activity and
  // its terminals running a command (both can keep the chat from moving).
  const chatThreads = useStore(
    useShallow((state) => selectSidebarThreadsForProjectRef(state, projectRef)),
  );
  const terminalStateByThreadKey = useTerminalStateStore((state) => state.terminalStateByThreadKey);
  const liveWork = useMemo(
    () =>
      chatThreadLiveWork(
        chatThreads,
        (threadId) =>
          selectThreadTerminalState(
            terminalStateByThreadKey,
            scopeThreadRef(environmentId, threadId),
          ).runningTerminalIds.length,
      ),
    [chatThreads, environmentId, terminalStateByThreadKey],
  );
  const activitySignature = chatActivitySignature(liveWork);

  const runPreview = useEvent(async (destination: string | null): Promise<PreviewState | null> => {
    const previewChat = readEnvironmentApi(environmentId)?.projects.promoteChatPreview;
    const seq = ++previewSeqRef.current;
    if (!previewChat) {
      setChecking(false);
      setPreviewFailure(describePromotionUnavailable());
      return null;
    }
    setChecking(true);
    try {
      const result = await previewChat({
        projectId: projectRef.projectId,
        ...(destination !== null ? { destination } : {}),
      });
      if (seq !== previewSeqRef.current) return null;
      const next: PreviewState = { requested: destination ?? result.defaultDestination, result };
      setPreview(next);
      setPreviewFailure(null);
      setChecking(false);
      return next;
    } catch (cause) {
      if (seq !== previewSeqRef.current) return null;
      setPreviewFailure(describePromotionError(cause));
      setChecking(false);
      return null;
    }
  });

  // First look: the server's default destination, renamed for the chat's title.
  const initialized = preview !== null;
  const loadInitialPreview = useEvent(async () => {
    const first = await runPreview(null);
    if (!first) return;
    const destination = initialDestinationForName(first.result.defaultDestination, name);
    lastPreviewKeyRef.current = `${destination}\u0000${refreshToken}`;
    setLocation(destination);
    if (destination !== first.requested) void runPreview(destination);
  });
  useEffect(() => {
    void loadInitialPreview();
  }, [loadInitialPreview]);

  // Live work in the chat changes whether it can move: re-check when it does.
  const lastActivityRef = useRef(activitySignature);
  useEffect(() => {
    if (lastActivityRef.current === activitySignature) return;
    lastActivityRef.current = activitySignature;
    setRefreshToken((value) => value + 1);
  }, [activitySignature]);

  const [debouncedLocation] = useDebouncedValue(location, {
    wait: DESTINATION_PREVIEW_DEBOUNCE_MS,
  });
  useEffect(() => {
    if (!initialized || phase !== "editing") return;
    const destination = debouncedLocation.trim();
    if (destination.length === 0) return;
    const key = `${destination}\u0000${refreshToken}`;
    if (lastPreviewKeyRef.current === key) return;
    lastPreviewKeyRef.current = key;
    void runPreview(destination);
  }, [debouncedLocation, initialized, phase, refreshToken, runPreview]);

  const trimmedLocation = location.trim();
  const currentPreview = preview !== null && preview.requested === trimmedLocation ? preview : null;
  const latestResult = preview?.result ?? null;
  const busy = describeChatBusy({
    busyThreadIds: latestResult?.busyThreadIds ?? [],
    work: liveWork,
  });
  const gitAvailable = latestResult?.gitAvailable ?? true;
  const gitOptions = effectiveGitOptions(
    { initializeGit, initialCommit, writeGitignore },
    gitAvailable,
  );
  const destinationState: DestinationCheckState =
    trimmedLocation.length === 0
      ? initialized
        ? "empty"
        : "checking"
      : currentPreview && !checking
        ? currentPreview.result.destinationStatus
        : "checking";

  // A taken destination: probe `<name>-2`, `-3`, … for the first free sibling.
  const takenDestination =
    currentPreview?.result.destinationStatus === "exists" ? currentPreview.requested : null;
  useEffect(() => {
    if (takenDestination === null) return;
    const previewChat = readEnvironmentApi(environmentId)?.projects.promoteChatPreview;
    if (!previewChat) return;
    let cancelled = false;
    void (async () => {
      for (const leaf of freeLeafCandidates(destinationLeaf(takenDestination))) {
        const destination = replaceDestinationLeaf(takenDestination, leaf);
        try {
          const result = await previewChat({ projectId: projectRef.projectId, destination });
          if (cancelled) return;
          if (result.destinationStatus === "available") {
            setSuggestion({ forDestination: takenDestination, destination, leaf });
            return;
          }
          if (result.destinationStatus !== "exists") return;
        } catch {
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [environmentId, projectRef.projectId, takenDestination]);
  const activeSuggestion =
    suggestion !== null && suggestion.forDestination === trimmedLocation ? suggestion : null;

  const blocker: PromotionSubmitBlocker | null = initialized
    ? resolvePromotionSubmitBlocker({
        name,
        destination: location,
        preview: currentPreview && !checking ? currentPreview.result : null,
      })
    : { field: "pending", reason: "Checking the chat folder…" };
  const ready = blocker === null && phase === "editing";

  const focusField = (field: PromotionSubmitBlocker["field"] | "location") => {
    if (field === "name") nameInputRef.current?.focus();
    if (field === "location") locationInputRef.current?.focus();
  };

  const finish = useEvent(async (result: ProjectsPromoteChatResult) => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
    const project = await (arrivalRef.current ??
      waitForPromotedProject(projectRef, PROMOTED_PROJECT_ARRIVAL_TIMEOUT_MS));
    if (project) {
      useUiStateStore.getState().setProjectExpanded(
        deriveLogicalProjectKeyFromSettings(project, {
          sidebarProjectGroupingMode: groupingMode,
          sidebarProjectGroupingOverrides: groupingOverrides,
        }),
        true,
      );
    }
    const threadRef = request.threadRef;
    if (
      threadRef &&
      (!routeThreadRef || scopedThreadKey(routeThreadRef) !== scopedThreadKey(threadRef))
    ) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    }
    // Let the sidebar render the project row the dialog folds into.
    await nextFrame();
    closePromoteChatDialog();
    const fileManagerLabel = getEditorLabel("file-manager", navigator.platform);
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: "Chat is now a project",
        description: `${name.trim()} · ${result.workspaceRoot}`,
        ...(isLocalChat
          ? {
              actionProps: {
                children: `Show in ${fileManagerLabel}`,
                onClick: () => void openFolderWithFeedback(result.workspaceRoot, "file-manager"),
              },
            }
          : {}),
      }),
    );
  });

  useEffect(() => {
    onCloseBehaviorChange(
      phase === "submitting"
        ? CLOSE_BLOCKED
        : phase === "done" && outcome
          ? { kind: "finish", finish: () => void finish(outcome) }
          : CLOSE_NOW,
    );
  }, [finish, onCloseBehaviorChange, outcome, phase]);

  const submit = useEvent(async () => {
    if (phase !== "editing") return;
    const destination = location.trim();
    let judged = currentPreview && !checking ? currentPreview : null;
    if (!judged && destination.length > 0) {
      lastPreviewKeyRef.current = `${destination}\u0000${refreshToken}`;
      judged = await runPreview(destination);
    }
    const reason = resolvePromotionSubmitBlocker({
      name,
      destination,
      preview: judged?.result ?? null,
    });
    if (reason || !judged) {
      if (reason) focusField(reason.field);
      return;
    }
    const promoteChat = readEnvironmentApi(environmentId)?.projects.promoteChat;
    if (!promoteChat) {
      setSubmitError(describePromotionUnavailable());
      return;
    }
    const options = effectiveGitOptions(
      { initializeGit, initialCommit, writeGitignore },
      judged.result.gitAvailable,
    );
    const expectedUpdatedAt = selectProjectByRef(useStore.getState(), projectRef)?.updatedAt;
    setSubmitError(null);
    setSteps(planPromotionSteps(options, judged.result));
    setPhase("submitting");
    // The fields go away while the move runs; focus waits on the button that
    // becomes "Done".
    primaryButtonRef.current?.focus();
    try {
      const result = await promoteChat({
        projectId: projectRef.projectId,
        ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
        title: name.trim(),
        destination: judged.result.destination.trim() || destination,
        ...options,
      });
      const settled = resolvePromotionSteps(options, result);
      onPromoted({
        projectRef,
        threadRef: request.threadRef,
        workspaceRoot: result.workspaceRoot,
      });
      arrivalRef.current = waitForPromotedProject(projectRef, PROMOTED_PROJECT_ARRIVAL_TIMEOUT_MS);
      setSteps(settled);
      setOutcome(result);
      setPhase("done");
      if (!promotionHasWarnings(settled)) {
        // Long enough to read the results once they have all settled in.
        holdTimerRef.current = window.setTimeout(
          () => void finish(result),
          PROMOTION_SUCCESS_HOLD_MS + settled.length * STEP_STAGGER_FACTOR * STACK_STEP_MS,
        );
      }
    } catch (cause) {
      const failure = describePromotionError(cause);
      setSubmitError(failure);
      setSubmitErrorDestination(destination);
      setPhase("editing");
      setFormEpoch((value) => value + 1);
      // Re-judge the location too, so its status line agrees with the refusal.
      if (failure.recovery === "refresh-preview" || isLocationFailure(failure)) {
        setRefreshToken((value) => value + 1);
      }
      if (failure.recovery === "fix-location") {
        window.requestAnimationFrame(() => locationInputRef.current?.focus());
      }
    }
  });

  const stopAgents = useEvent(async () => {
    // Only a working agent can be interrupted; a terminal command is not a turn.
    const threadIds = busy?.stoppableThreadIds ?? [];
    if (threadIds.length === 0) return;
    setStopping(true);
    try {
      await Promise.all(
        threadIds.map((threadId: ThreadId) => interruptThreadTurn({ environmentId, threadId })),
      );
    } finally {
      setStopping(false);
      setRefreshToken((value) => value + 1);
    }
  });

  const pickFolder = useEvent(async () => {
    const api = readLocalApi();
    if (!api) return;
    const leaf = destinationLeaf(location) || projectFolderLeafForName(name);
    const directory = getBrowseDirectoryPath(location.trim());
    try {
      const picked = await api.dialogs.pickFolder(
        directory.length > 0 ? { initialPath: directory } : undefined,
      );
      if (picked) setLocation(joinDestination(picked, leaf));
    } catch {
      // The native picker failing leaves the typed location as it was.
    }
  });

  const done = phase === "done" ? outcome : null;
  const activeSubmitError =
    submitError &&
    promotionErrorStillApplies({
      failure: submitError,
      failedDestination: submitErrorDestination,
      destination: trimmedLocation,
    })
      ? submitError
      : null;
  const failure = phase === "editing" ? (activeSubmitError ?? previewFailure) : null;
  const fatal = failure?.recovery === "none";
  // The busy alert and the location status line explain those blockers in place.
  const footerHint =
    phase === "submitting"
      ? "Keep this open while the files move."
      : !fatal && (blocker?.field === "name" || blocker?.field === "pending")
        ? blocker.reason
        : null;

  return (
    <>
      <DialogHeader>
        <div className="flex items-start gap-3 pe-8">
          <span
            aria-hidden
            className="grid size-9 shrink-0 place-items-center rounded-xl border border-primary/20 bg-primary/8 text-primary"
          >
            <FolderGit2Icon className="size-4.5" />
          </span>
          <div className="flex min-w-0 flex-col gap-1.5">
            <DialogTitle>
              <RollingText
                text={done ? "Your chat is now a project" : "Turn this chat into a project"}
              />
            </DialogTitle>
            <DialogDescription>
              {done
                ? done.gitInitialized
                  ? "Git, diffs, checkpoints and project settings are ready, and the conversation came along."
                  : "Project settings are ready, and the conversation came along. Add Git from the project any time."
                : "Projects get Git, branches and worktrees, diffs, checkpoints and their own settings."}
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>
      <DialogPanel>
        <AnimatedHeight>
          {phase === "editing" ? (
            <form
              id={PROMOTE_FORM_ID}
              key={`form-${formEpoch}`}
              noValidate
              aria-label="Turn this chat into a project"
              className="flex flex-col gap-5"
              style={formEpoch > 0 ? riseIn(0) : undefined}
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              {failure ? (
                <PromotionErrorNotice
                  failure={failure}
                  onRetry={() => {
                    setSubmitError(null);
                    if (!initialized) void loadInitialPreview();
                    else setRefreshToken((value) => value + 1);
                  }}
                />
              ) : null}
              {busy && !fatal ? (
                <BusyNotice
                  busy={busy}
                  stopping={stopping}
                  checking={checking}
                  onStop={() => void stopAgents()}
                  onRecheck={() => setRefreshToken((value) => value + 1)}
                />
              ) : null}
              {fatal ? null : (
                <>
                  <div className="flex flex-col gap-2">
                    <label
                      htmlFor="promote-chat-name"
                      className="font-medium text-foreground text-sm"
                    >
                      Name
                    </label>
                    <Input
                      id="promote-chat-name"
                      ref={nameInputRef}
                      value={name}
                      maxLength={CHAT_PROJECT_TITLE_MAX_CHARS}
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={blocker?.field === "name" || undefined}
                      data-testid="promote-chat-name"
                      onChange={(event) => {
                        const next = event.target.value;
                        setLocation((current) =>
                          retargetDestinationForName({
                            destination: current,
                            previousName: name,
                            nextName: next,
                          }),
                        );
                        setName(next);
                      }}
                    />
                  </div>
                  <DestinationField
                    environmentId={environmentId}
                    value={location}
                    initialized={initialized}
                    state={destinationState}
                    suggestion={activeSuggestion}
                    inputRef={locationInputRef}
                    canPickNatively={canPickNatively}
                    folderLeaf={projectFolderLeafForName(name)}
                    onChange={setLocation}
                    onPickFolder={() => void pickFolder()}
                  />
                  <GitOptions
                    gitAvailable={gitAvailable}
                    gitIdentityConfigured={latestResult?.gitIdentityConfigured ?? true}
                    initializeGit={initializeGit}
                    initialCommit={initialCommit}
                    writeGitignore={writeGitignore}
                    onInitializeGitChange={setInitializeGit}
                    onInitialCommitChange={setInitialCommit}
                    onWriteGitignoreChange={setWriteGitignore}
                  />
                  <WhatWillHappen
                    preview={latestResult}
                    destination={trimmedLocation}
                    gitOptions={gitOptions}
                    gitAvailable={gitAvailable}
                  />
                </>
              )}
            </form>
          ) : (
            <PromotionProgress
              phase={phase}
              steps={steps}
              showIdentityHelp={
                phase === "done" &&
                latestResult !== null &&
                !latestResult.gitIdentityConfigured &&
                steps.some((step) => step.id === "initial-commit" && step.status === "warning")
              }
            />
          )}
        </AnimatedHeight>
      </DialogPanel>
      {/* Fixed slots: the primary button stays the same element from "Turn into
          project" to "Done", so focus never drops while the results arrive. */}
      <DialogFooter className="sm:items-center">
        <p
          aria-live="polite"
          className="min-w-0 text-muted-foreground text-xs empty:hidden sm:me-auto max-sm:order-last"
          data-testid="promote-chat-footer-hint"
        >
          {footerHint}
        </p>
        {done && isLocalChat ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => void openFolderWithFeedback(done.workspaceRoot, "file-manager")}
          >
            <FolderOpenIcon aria-hidden />
            Show in {getEditorLabel("file-manager", navigator.platform)}
          </Button>
        ) : null}
        {done ? null : (
          <Button
            type="button"
            variant="outline"
            data-testid="promote-chat-cancel"
            disabled={phase === "submitting"}
            onClick={() => closePromoteChatDialog()}
          >
            {fatal ? "Close" : "Cancel"}
          </Button>
        )}
        {fatal ? null : (
          <Button
            ref={primaryButtonRef}
            type={done ? "button" : "submit"}
            form={done ? undefined : PROMOTE_FORM_ID}
            data-promote-primary
            data-testid={done ? "promote-chat-done" : "promote-chat-submit"}
            aria-disabled={done || ready ? undefined : true}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-64"
            onClick={(event) => {
              if (done) {
                void finish(done);
                return;
              }
              if (ready) return;
              event.preventDefault();
              if (blocker) focusField(blocker.field);
            }}
          >
            {done ? (
              "Done"
            ) : phase === "submitting" ? (
              <>
                <Spinner className="size-3.5" />
                Turning into project…
              </>
            ) : (
              "Turn into project"
            )}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

/* ───────── Motion helpers ───────── */

/** A short rise-in on the house "stack" step; zero under reduced motion. */
function riseIn(index: number): CSSProperties {
  return {
    animation: `side-chat-rise var(--app-motion-duration-stack) var(--app-motion-spring-gentle) ${staggerDelay(index)} backwards`,
  };
}

function popIn(index: number): CSSProperties {
  return {
    animation: `chapter-glyph-pop var(--app-motion-duration-stack) var(--app-motion-spring-snappy) ${staggerDelay(index)} backwards`,
  };
}

function staggerDelay(index: number): string {
  return `calc(var(--app-motion-duration-stack) * ${index * STEP_STAGGER_FACTOR})`;
}

/* ───────── Location ───────── */

interface FolderSuggestion {
  readonly name: string;
  readonly destination: string;
}

function DestinationField({
  environmentId,
  value,
  initialized,
  state,
  suggestion,
  inputRef,
  canPickNatively,
  folderLeaf,
  onChange,
  onPickFolder,
}: {
  readonly environmentId: ScopedProjectRef["environmentId"];
  readonly value: string;
  readonly initialized: boolean;
  readonly state: DestinationCheckState;
  readonly suggestion: FreeNameSuggestion | null;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly canPickNatively: boolean;
  /** The folder name a project picked into another folder gets (from its name). */
  readonly folderLeaf: string;
  readonly onChange: (value: string) => void;
  readonly onPickFolder: () => void;
}) {
  const [popupOpen, setPopupOpen] = useState(false);
  const directory = getBrowseDirectoryPath(value.trim());
  const leaf = getBrowseLeafPathSegment(value.trim());
  const browse = useFilesystemBrowse({
    environmentId: environmentId,
    partialPath: directory,
    enabled: popupOpen && directory.length > 0 && isFilesystemBrowseQuery(directory),
  });
  // Folders beside the destination, matching its last segment as typed:
  // picking one puts the project (named after the project) inside it.
  const suggestions = useMemo<FolderSuggestion[]>(() => {
    const entries = browse.data?.entries ?? [];
    return filterBrowseEntries({
      browseEntries: entries,
      browseFilterQuery: leaf,
      highlightedItemValue: null,
    })
      .filteredEntries.filter((entry) => entry.name !== leaf)
      .slice(0, MAX_FOLDER_SUGGESTIONS)
      .map((entry) => ({
        name: entry.name,
        destination: joinDestination(entry.fullPath, folderLeaf),
      }));
  }, [browse.data?.entries, leaf, folderLeaf]);
  const status = describeDestinationStatus(state);

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="promote-chat-location" className="font-medium text-sm text-foreground">
        Location
      </label>
      <div className="flex min-w-0 gap-2">
        <Autocomplete
          items={suggestions}
          mode="none"
          value={value}
          open={popupOpen && suggestions.length > 0}
          onOpenChange={setPopupOpen}
          itemToStringValue={(item: FolderSuggestion) => item.destination}
          onValueChange={(next, details) => {
            onChange(next);
            // Typing browses; picking a folder settles the location.
            setPopupOpen(details.reason === "input-change");
          }}
        >
          <AutocompleteInput
            id="promote-chat-location"
            ref={inputRef}
            className="min-w-0 flex-1 font-mono text-xs"
            placeholder={initialized ? "/path/to/new-project" : "Finding a good spot…"}
            disabled={!initialized}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="promote-chat-location-status"
            aria-invalid={state !== "available" && state !== "checking"}
            data-testid="promote-chat-location"
          />
          <AutocompletePopup>
            <AutocompleteList>
              {(item: FolderSuggestion) => (
                <AutocompleteItem key={item.destination} value={item} className="gap-2">
                  <FolderOpenIcon aria-hidden className="size-3.5 text-muted-foreground" />
                  <span className="truncate">{item.name}</span>
                </AutocompleteItem>
              )}
            </AutocompleteList>
          </AutocompletePopup>
        </Autocomplete>
        {canPickNatively ? (
          <Button type="button" variant="outline" disabled={!initialized} onClick={onPickFolder}>
            <FolderOpenIcon aria-hidden />
            Browse…
          </Button>
        ) : null}
      </div>
      <div
        id="promote-chat-location-status"
        aria-live="polite"
        className="flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1 text-xs"
        data-testid="promote-chat-location-status"
        data-state={state}
      >
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full transition-colors duration-(--app-motion-duration-chip)",
            status.tone === "positive" && "bg-success",
            status.tone === "caution" && "bg-warning",
            status.tone === "negative" && "bg-destructive",
            status.tone === "neutral" && "bg-muted-foreground/40",
          )}
        />
        <RollingText
          text={status.text}
          className={cn(
            "transition-colors duration-(--app-motion-duration-chip)",
            status.tone === "positive" && "text-success-foreground",
            status.tone === "caution" && "text-warning-foreground",
            status.tone === "negative" && "text-destructive-foreground",
            status.tone === "neutral" && "text-muted-foreground",
          )}
        />
        {suggestion ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="h-6 rounded-full px-2 font-mono text-[11px] sm:h-6 sm:text-[11px]"
            style={riseIn(0)}
            data-testid="promote-chat-use-suggestion"
            onClick={() => onChange(suggestion.destination)}
          >
            Use {suggestion.leaf}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/* ───────── Git options ───────── */

function GitOptions(props: {
  readonly gitAvailable: boolean;
  readonly gitIdentityConfigured: boolean;
  readonly initializeGit: boolean;
  readonly initialCommit: boolean;
  readonly writeGitignore: boolean;
  readonly onInitializeGitChange: (value: boolean) => void;
  readonly onInitialCommitChange: (value: boolean) => void;
  readonly onWriteGitignoreChange: (value: boolean) => void;
}) {
  const gitOn = props.gitAvailable && props.initializeGit;
  const showIdentityNotice = shouldShowGitIdentityNotice({
    gitAvailable: props.gitAvailable,
    gitIdentityConfigured: props.gitIdentityConfigured,
    options: {
      initializeGit: props.initializeGit,
      initialCommit: props.initialCommit,
      writeGitignore: props.writeGitignore,
    },
  });
  return (
    <fieldset className="flex flex-col rounded-xl border border-border/70 px-3.5 py-3">
      <legend className="sr-only">Git</legend>
      <label className="flex cursor-pointer items-start gap-3 has-disabled:cursor-not-allowed">
        <Switch
          className="mt-0.5"
          checked={gitOn}
          disabled={!props.gitAvailable}
          data-testid="promote-chat-initialize-git"
          onCheckedChange={(checked) => props.onInitializeGitChange(Boolean(checked))}
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium text-sm">Initialize Git</span>
          <span className="text-muted-foreground text-xs">
            {props.gitAvailable
              ? "Track changes and use branches, worktrees, diffs and checkpoints."
              : "Git is not installed on this device. You can set it up from the project later."}
          </span>
        </span>
      </label>
      <DisclosureRegion open={gitOn}>
        <div className="flex flex-col gap-2.5 ps-12 pt-3">
          <label className="flex cursor-pointer items-center gap-2.5 text-sm">
            <Checkbox
              checked={props.initialCommit}
              data-testid="promote-chat-initial-commit"
              onCheckedChange={(checked) => props.onInitialCommitChange(Boolean(checked))}
            />
            Make an initial commit
          </label>
          <DisclosureRegion open={showIdentityNotice}>
            <GitIdentityHelp>
              Git doesn't know your name and email on this device yet, so the initial commit will be
              skipped. Set them once, and it works from then on:
            </GitIdentityHelp>
          </DisclosureRegion>
          <label className="flex cursor-pointer items-start gap-2.5 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={props.writeGitignore}
              data-testid="promote-chat-gitignore"
              onCheckedChange={(checked) => props.onWriteGitignoreChange(Boolean(checked))}
            />
            <span className="flex flex-col gap-0.5">
              Add a .gitignore
              <span className="text-muted-foreground text-xs">
                Ignores .DS_Store, node_modules/, .env files and Ryco's worktrees. An existing one
                is kept.
              </span>
            </span>
          </label>
        </div>
      </DisclosureRegion>
    </fieldset>
  );
}

function GitIdentityHelp(props: { readonly children: ReactNode }) {
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-warning/32 bg-warning/4 px-3 py-2.5 text-xs"
      data-testid="promote-chat-identity-notice"
    >
      <p className="flex gap-2 text-foreground/90">
        <AlertTriangleIcon
          aria-hidden
          className="mt-px size-3.5 shrink-0 text-warning-foreground"
        />
        <span>{props.children}</span>
      </p>
      <ul className="flex flex-col gap-1">
        {GIT_IDENTITY_COMMANDS.map((command) => (
          <CopyableCommand key={command} command={command} />
        ))}
      </ul>
    </div>
  );
}

function CopyableCommand(props: { readonly command: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>();
  return (
    <li className="flex min-w-0 items-center gap-1 rounded-md bg-background/70 py-0.5 ps-2 pe-0.5 dark:bg-input/32">
      <code className="min-w-0 flex-1 truncate font-mono text-[11px]" title={props.command}>
        {props.command}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="size-6 sm:size-6"
        aria-label={isCopied ? "Copied" : `Copy ${props.command}`}
        onClick={() => copyToClipboard(props.command)}
      >
        {isCopied ? (
          <CheckIcon aria-hidden className="size-3 text-success-foreground" />
        ) : (
          <CopyIcon aria-hidden className="size-3" />
        )}
      </Button>
    </li>
  );
}

/* ───────── What will happen ───────── */

function WhatWillHappen(props: {
  readonly preview: ProjectsPromoteChatPreviewResult | null;
  readonly destination: string;
  readonly gitOptions: ReturnType<typeof effectiveGitOptions>;
  readonly gitAvailable: boolean;
}) {
  const { preview } = props;
  const move = preview ? describeMovePlan(preview) : null;
  const git = describeGitPlan(props.gitOptions, props.gitAvailable);
  return (
    <section
      aria-labelledby="promote-chat-plan-heading"
      className="flex flex-col gap-3 rounded-xl bg-muted/40 px-3.5 py-3 dark:bg-input/24"
      data-testid="promote-chat-plan"
    >
      <h3
        id="promote-chat-plan-heading"
        className="font-medium text-[11px] text-muted-foreground uppercase tracking-wider"
      >
        What will happen
      </h3>
      <ul className="flex flex-col gap-3">
        <PlanItem icon={<ArrowRightIcon className="size-3.5" />}>
          {preview && move ? (
            <>
              <span className="font-medium text-sm" data-testid="promote-chat-move-plan">
                {move.title}
              </span>
              <PathMove from={preview.source} to={props.destination || preview.destination} />
              {move.detail ? (
                <span className="text-muted-foreground text-xs">{move.detail}</span>
              ) : null}
            </>
          ) : (
            <span className="flex flex-col gap-1.5 pt-0.5">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-3 w-64" />
            </span>
          )}
        </PlanItem>
        <PlanItem icon={<MessageSquareIcon className="size-3.5" />}>
          <span className="font-medium text-sm">Your conversation stays attached</span>
          <span className="text-muted-foreground text-xs">
            The agent restarts in the new folder and continues from a summary of this chat.
          </span>
        </PlanItem>
        <PlanItem icon={<GitBranchIcon className="size-3.5" />}>
          <RollingText text={git.title} className="font-medium text-sm" />
          {git.detail ? <span className="text-muted-foreground text-xs">{git.detail}</span> : null}
        </PlanItem>
      </ul>
    </section>
  );
}

function PlanItem(props: { readonly icon: ReactNode; readonly children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className="mt-px grid size-6 shrink-0 place-items-center rounded-full bg-background text-muted-foreground shadow-xs/5 dark:bg-input/48"
      >
        {props.icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">{props.children}</span>
    </li>
  );
}

/** "source → destination", each keeping its last segment visible when space runs out. */
function PathMove(props: { readonly from: string; readonly to: string }) {
  return (
    <span className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2 gap-y-0.5 font-mono text-[11px]">
      <span className="text-muted-foreground">from</span>
      <PathLabel path={props.from} />
      <span className="text-muted-foreground">to</span>
      <PathLabel path={props.to} emphasize />
    </span>
  );
}

function PathLabel(props: { readonly path: string; readonly emphasize?: boolean }) {
  const leaf = getBrowseLeafPathSegment(props.path);
  const parent = props.path.slice(0, props.path.length - leaf.length);
  return (
    <span className="flex min-w-0" title={props.path}>
      <span className="truncate text-muted-foreground">{parent}</span>
      <span className={cn("shrink-0", props.emphasize ? "text-foreground" : "text-foreground/80")}>
        {leaf}
      </span>
    </span>
  );
}

/* ───────── Notices ───────── */

function BusyNotice(props: {
  readonly busy: ChatBusyPresentation;
  readonly stopping: boolean;
  readonly checking: boolean;
  readonly onStop: () => void;
  readonly onRecheck: () => void;
}) {
  const { busy } = props;
  return (
    <Alert variant="warning" data-testid="promote-chat-busy" style={riseIn(0)}>
      <AlertTriangleIcon aria-hidden />
      <AlertTitle>
        <RollingText text={busy.title} />
      </AlertTitle>
      <AlertDescription>
        <span>{busy.message}</span>
        <span className="flex flex-wrap gap-2">
          {busy.stoppableThreadIds.length > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={props.stopping}
              onClick={props.onStop}
            >
              {props.stopping ? <Spinner className="size-3" /> : null}
              Stop the agent
            </Button>
          ) : null}
          {busy.offerRecheck ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={props.checking}
              onClick={props.onRecheck}
            >
              {props.checking ? <Spinner className="size-3" /> : null}
              Check again
            </Button>
          ) : null}
        </span>
      </AlertDescription>
    </Alert>
  );
}

function PromotionErrorNotice(props: {
  readonly failure: PromotionErrorPresentation;
  readonly onRetry: () => void;
}) {
  const { failure } = props;
  return (
    <Alert
      variant={failure.recovery === "none" ? "error" : "warning"}
      data-testid="promote-chat-error"
      data-reason={failure.reason ?? "unknown"}
      style={riseIn(0)}
    >
      <AlertTriangleIcon aria-hidden />
      <AlertTitle>{failure.title}</AlertTitle>
      <AlertDescription>
        <span>{failure.message}</span>
        {failure.recovery === "retry" ? (
          <span>
            <Button type="button" variant="outline" size="xs" onClick={props.onRetry}>
              Try again
            </Button>
          </span>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/* ───────── Progress ───────── */

function PromotionProgress(props: {
  readonly phase: Exclude<Phase, "editing">;
  readonly steps: ReadonlyArray<PromotionStep>;
  readonly showIdentityHelp: boolean;
}) {
  const settled = props.phase === "done";
  const warning = props.steps.find((step) => step.status === "warning");
  const announcement = !settled
    ? "Turning the chat into a project…"
    : warning
      ? `The chat is now a project. ${warning.label}: ${warning.detail ?? "needs attention"}.`
      : "The chat is now a project.";
  return (
    <div className="flex flex-col gap-4" style={riseIn(0)} data-testid="promote-chat-progress">
      <p className="sr-only" aria-live="polite" role="status">
        {announcement}
      </p>
      <ol className="flex flex-col gap-3" aria-label="Progress">
        {props.steps.map((step, index) => (
          <PromotionStepRow key={step.id} step={step} index={index} settled={settled} />
        ))}
      </ol>
      {props.showIdentityHelp ? (
        <div style={riseIn(props.steps.length)}>
          <GitIdentityHelp>
            Set your Git name and email, then make the first commit from the project's Git actions:
          </GitIdentityHelp>
        </div>
      ) : null}
    </div>
  );
}

function PromotionStepRow(props: {
  readonly step: PromotionStep;
  readonly index: number;
  readonly settled: boolean;
}) {
  const { step, index, settled } = props;
  return (
    <li
      className="flex items-start gap-3"
      data-testid={`promote-step-${step.id}`}
      data-status={step.status}
    >
      <span
        key={step.status}
        aria-hidden
        style={settled ? popIn(index) : undefined}
        className={cn(
          "mt-px grid size-5 shrink-0 place-items-center rounded-full",
          step.status === "done" && "bg-success/12 text-success-foreground",
          step.status === "warning" && "bg-warning/14 text-warning-foreground",
          step.status === "skipped" && "bg-muted text-muted-foreground",
          step.status === "running" && "text-foreground",
          step.status === "pending" && "text-muted-foreground/60",
        )}
      >
        <StepGlyph status={step.status} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            "font-medium text-sm",
            step.status === "pending" && "text-muted-foreground",
          )}
        >
          {step.label}
          <span className="sr-only"> ({stepStatusLabel(step.status)})</span>
        </span>
        {step.detail ? (
          <span
            key={`${step.status}-detail`}
            style={settled ? riseIn(index) : undefined}
            className={cn(
              "break-words text-xs",
              step.status === "warning" ? "text-foreground/85" : "text-muted-foreground",
              step.id === "move" && step.status === "done" && "font-mono text-[11px]",
            )}
          >
            {step.detail}
          </span>
        ) : null}
      </span>
    </li>
  );
}

function StepGlyph(props: { readonly status: PromotionStep["status"] }) {
  switch (props.status) {
    case "running":
      return <Spinner className="size-3.5" />;
    case "done":
      return <CheckIcon className="size-3" strokeWidth={3} />;
    case "warning":
      return <AlertTriangleIcon className="size-3" />;
    case "skipped":
      return <MinusIcon className="size-3" />;
    case "pending":
      return <CircleIcon className="size-3" />;
  }
}

function stepStatusLabel(status: PromotionStep["status"]): string {
  switch (status) {
    case "running":
      return "in progress";
    case "done":
      return "done";
    case "warning":
      return "needs attention";
    case "skipped":
      return "skipped";
    case "pending":
      return "waiting";
  }
}
