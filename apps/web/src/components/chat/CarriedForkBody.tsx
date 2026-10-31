// FILE: CarriedForkBody.tsx
// Purpose: "Fork from here" → "Another machine": carry this conversation to
//          another of the user's machines and continue it there
//          (`threads.forkCarried`, docs/thread-forks.md#continue-on-another-machine).
// Layer: Web UI, in the fork dialog's lazy chunk only. Which machines qualify,
//        the branch rule, the model mapping, the carried conversation, the key
//        a retry reuses and the guarded call are the shared client runtime's
//        (`@ryco/client-runtime/state/threads/carriedFork`); this file reads
//        the stores and renders. The source machine is only read; the target
//        machine gets one request, checked against its own reviewed
//        connection; "Archive the original afterwards" is an ordinary archive
//        on the source, by this user, once the target confirmed the fork.

import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  captureReviewedSendReadiness,
  resolveChatsAvailability,
} from "@ryco/client-runtime/state/composer";
import {
  describeThreadForkFailure,
  isArchivedThreadStub,
  THREAD_FORK_COPY,
  threadForkShellPorts,
  type ThreadForkAttemptNotice,
  type ThreadForkFailedOutcome,
} from "@ryco/client-runtime/state/threads";
import {
  buildCarriedForkInput,
  buildCarriedThreadHistory,
  CARRIED_FORK_COPY,
  carriedForkBranch,
  carriedForkBranchLine,
  carriedForkKey,
  carriedForkModel,
  carriedForkSignature,
  type CarriedForkTarget,
  type CarriedForkTargetCandidate,
  listCarriedForkTargets,
  readCarriedForkApi,
  readCarriedForkSource,
  runCarriedFork,
  settleCarriedForkKey,
} from "@ryco/client-runtime/state/threads/carriedFork";
import {
  type EnvironmentId,
  type ServerConfig,
  type ThreadForkKey,
  type ThreadForkResult,
  WS_METHODS,
} from "@ryco/contracts";
import { isChatProject } from "@ryco/shared/projectKind";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { useNavigate } from "@tanstack/react-router";
import { GitForkIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";

import { readEnvironmentApi } from "../../environmentApi";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  listEnvironmentConnections,
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import {
  readHostedRpcCapability,
  subscribeHostedRpcCapabilities,
} from "../../hostedHub/capabilities";
import {
  readEnvironmentServerConfig,
  useEnvironmentServerConfig,
} from "../../hooks/useChatsAvailability";
import { useEvent } from "../../hooks/useEvent";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useGitStatus } from "../../lib/gitStatusState";
import { cn, randomUUID } from "../../lib/utils";
import { selectEnvironmentState, selectProjectByRef, type AppState, useStore } from "../../store";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "../ui/dialog";
import { RadioGroup } from "../ui/radio-group";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { closeForkThreadDialog, type ForkThreadDialogRequest } from "./forkThreadDialogStore";

const CARRIED_FORM_ID = "carried-fork-form";

function mintForkKey(): ThreadForkKey {
  return `fork-${randomUUID().replaceAll("-", "")}`;
}

let cachedConnections = listEnvironmentConnections();
function readConnections() {
  const next = listEnvironmentConnections();
  if (
    next.length !== cachedConnections.length ||
    next.some((connection, index) => connection !== cachedConnections[index])
  ) {
    cachedConnections = next;
  }
  return cachedConnections;
}

function providersOf(config: ServerConfig | null): CarriedForkTargetCandidate["providers"] {
  return (config?.providers ?? []).map((provider) => ({
    instanceId: provider.instanceId,
    driver: provider.driver,
    enabled: provider.enabled,
    label: provider.displayName ?? provider.instanceId,
  }));
}

/** This client's view of the other machines, read from its own stores. */
function useCarriedForkCandidates(): ReadonlyArray<CarriedForkTargetCandidate> {
  const connections = useSyncExternalStore(subscribeEnvironmentConnections, readConnections);
  // Which connected machines the shared capability policy lets this session fork on, as one
  // string so an unchanged answer keeps its identity.
  const allowed = useSyncExternalStore(subscribeHostedRpcCapabilities, () =>
    connections
      .map((connection) =>
        readHostedRpcCapability(WS_METHODS.threadsForkCarried, connection.environmentId).allowed
          ? "1"
          : "0",
      )
      .join(""),
  );
  const saved = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryConfig = useEnvironmentServerConfig(primaryEnvironmentId);
  const projectRecords = useStore(
    useShallow((state: AppState) =>
      connections.map(
        (connection) => selectEnvironmentState(state, connection.environmentId).projectById,
      ),
    ),
  );
  return useMemo(() => {
    return connections.map((connection, index): CarriedForkTargetCandidate => {
      const environmentId = connection.environmentId;
      const config =
        environmentId === primaryEnvironmentId
          ? primaryConfig
          : (saved[environmentId]?.serverConfig ?? readEnvironmentServerConfig(environmentId));
      const capabilities = config?.environment.capabilities;
      return {
        environmentId,
        label: connection.knownEnvironment.label,
        connected: true,
        allowed: allowed[index] === "1",
        supported: capabilities?.threadForkCarried === true,
        chatsAvailable: resolveChatsAvailability(config).available,
        providers: providersOf(config),
        projects: Object.values(projectRecords[index] ?? {}).flatMap((project) =>
          project
            ? [
                {
                  id: project.id,
                  cwd: project.cwd,
                  repositoryIdentity: project.repositoryIdentity ?? null,
                  isChat: isChatProject(project),
                },
              ]
            : [],
        ),
      };
    });
  }, [allowed, connections, primaryConfig, primaryEnvironmentId, projectRecords, saved]);
}

/** The machines a source thread can continue on; empty hides "Another machine". */
export function useCarriedForkTargets(
  request: ForkThreadDialogRequest,
): ReadonlyArray<CarriedForkTarget> {
  const { sourceThreadRef } = request;
  const environmentId = sourceThreadRef.environmentId;
  const shell = useStore(
    useMemo(
      () => (state: AppState) =>
        selectEnvironmentState(state, environmentId).threadShellById[sourceThreadRef.threadId],
      [environmentId, sourceThreadRef.threadId],
    ),
  );
  const shellProjectId = shell?.projectId;
  const project = useStore(
    useMemo(
      () => (state: AppState) =>
        shellProjectId
          ? selectProjectByRef(state, { environmentId, projectId: shellProjectId })
          : undefined,
      [environmentId, shellProjectId],
    ),
  );
  const sourceConfig = useEnvironmentServerConfig(environmentId);
  const candidates = useCarriedForkCandidates();
  return useMemo(() => {
    if (!shell || !project || isArchivedThreadStub(shell)) return [];
    const driver =
      carriedForkModel(shell.modelSelection, providersOf(sourceConfig))?.driver ?? null;
    return listCarriedForkTargets({
      sourceEnvironmentId: environmentId,
      source: isChatProject(project)
        ? { isChat: true }
        : {
            isChat: false,
            projectId: project.id,
            cwd: project.cwd,
            repositoryIdentity: project.repositoryIdentity ?? null,
          },
      driver,
      candidates,
    });
  }, [candidates, environmentId, project, shell, sourceConfig]);
}

type Phase = "idle" | "reading" | "sending" | "opening";

export function CarriedForkBody(props: {
  readonly request: ForkThreadDialogRequest;
  readonly targets: ReadonlyArray<CarriedForkTarget>;
  /** "Continue on: This machine / Another machine". */
  readonly machineSwitch: ReactNode;
  readonly onBusyChange: (busy: boolean) => void;
}) {
  const { request, targets, onBusyChange } = props;
  const { sourceThreadRef } = request;
  const sourceEnvironmentId = sourceThreadRef.environmentId;
  const navigate = useNavigate();
  const { archiveThread } = useThreadActions();

  const shell = useStore(
    useMemo(
      () => (state: AppState) =>
        selectEnvironmentState(state, sourceEnvironmentId).threadShellById[
          sourceThreadRef.threadId
        ],
      [sourceEnvironmentId, sourceThreadRef.threadId],
    ),
  );
  const sourceProjectId = shell?.projectId;
  const project = useStore(
    useMemo(
      () => (state: AppState) =>
        sourceProjectId
          ? selectProjectByRef(state, {
              environmentId: sourceEnvironmentId,
              projectId: sourceProjectId,
            })
          : undefined,
      [sourceEnvironmentId, sourceProjectId],
    ),
  );
  const isChat = project ? isChatProject(project) : false;
  // The source checkout's own branch: the one the other machine starts from.
  const gitStatus = useGitStatus({
    environmentId: sourceEnvironmentId,
    cwd: project && !isChat ? (shell?.worktreePath ?? project.cwd) : null,
  });
  const branch = isChat ? null : carriedForkBranch(gitStatus.data);

  const [chosen, setChosen] = useState<EnvironmentId | null>(null);
  const target =
    targets.find((entry) => entry.environmentId === chosen && entry.enabled) ??
    targets.find((entry) => entry.enabled) ??
    null;
  const [archiveAfter, setArchiveAfter] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [notice, setNotice] = useState<ThreadForkAttemptNotice | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [pushing, setPushing] = useState(false);
  const busy = phase !== "idle";
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const sendable = target !== null && shell !== undefined && (isChat || branch?.kind === "ready");

  const fail = (failure: ThreadForkFailedOutcome | { readonly message: string }) => {
    if ("status" in failure) {
      const described = describeThreadForkFailure(failure);
      setNotice({
        tone: failure.status === "uncertain" ? "warning" : "error",
        title:
          failure.status === "uncertain"
            ? THREAD_FORK_COPY.titles.uncertain
            : THREAD_FORK_COPY.titles.failed,
        message: described.message,
        detail: failure.status === "failed" ? failure.detail : null,
      });
      setCanRetry(described.canRetry);
    } else {
      setNotice({
        tone: "error",
        title: THREAD_FORK_COPY.titles.notSent,
        message: failure.message,
        detail: null,
      });
      setCanRetry(false);
    }
    setPhase("idle");
  };

  const opened = useEvent(async (result: ThreadForkResult, signal: AbortSignal) => {
    if (target === null) return;
    const forkRef = scopeThreadRef(target.environmentId, result.threadId);
    if (archiveAfter) {
      // An ordinary archive on the source machine, by this user, after the target confirmed.
      try {
        await archiveThread(sourceThreadRef);
      } catch {
        toastManager.add(
          stackedThreadToast({ type: "warning", title: CARRIED_FORK_COPY.archiveFailed }),
        );
      }
    }
    setPhase("opening");
    const arrived = await threadForkShellPorts(target.environmentId)
      .waitForShell(result, signal)
      .catch(() => false);
    onBusyChange(false);
    closeForkThreadDialog();
    const open = () => {
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(forkRef) });
    };
    if (arrived) {
      open();
      return;
    }
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: "Fork created",
        description: `It will appear in the sidebar once ${target.label} syncs it.`,
        actionProps: { children: "Open fork", onClick: open },
      }),
    );
  });

  const submit = useEvent(async () => {
    if (busy || !sendable || target === null || shell === undefined) return;
    setNotice(null);
    // The reviewed target connection: if it changes before the request leaves, nothing is sent.
    const assertMutationReady = captureReviewedSendReadiness(
      target.environmentId,
      () => readEnvironmentConnection(target.environmentId),
      THREAD_FORK_COPY.connectionChanged,
    );
    const controller = new AbortController();
    abort.current = controller;
    setPhase("reading");
    const sourceApi = readEnvironmentApi(sourceEnvironmentId);
    if (!sourceApi) return fail({ message: THREAD_FORK_COPY.connectionChanged });
    let read;
    try {
      read = await readCarriedForkSource({
        api: sourceApi,
        threadId: sourceThreadRef.threadId,
        signal: controller.signal,
        isCurrent: () => readEnvironmentApi(sourceEnvironmentId) === sourceApi,
      });
    } catch (error) {
      return fail({
        message: error instanceof Error ? error.message : CARRIED_FORK_COPY.sourceChanged,
      });
    }
    const model = carriedForkModel(
      read.thread.modelSelection,
      providersOf(readEnvironmentServerConfig(sourceEnvironmentId)),
    );
    if (model === null) return fail({ message: THREAD_FORK_COPY.errors.unavailable });
    const built = buildCarriedThreadHistory({
      messages: read.messages,
      proposedPlans: read.proposedPlans,
      turnOutcomes: read.turnOutcomes,
      boundaryMessageId: request.sourceMessageId,
      source: {
        machineLabel: (
          readEnvironmentConnection(sourceEnvironmentId)?.knownEnvironment.label ??
          "Another machine"
        ).slice(0, 120),
        threadTitle: (read.thread.title.trim() || "Untitled").slice(0, 200),
        threadId: sourceThreadRef.threadId,
        environmentId: sourceEnvironmentId,
      },
      model,
      runtimeMode: read.thread.runtimeMode,
      interactionMode: read.thread.interactionMode,
      ...(read.thread.tokenMode !== undefined ? { tokenMode: read.thread.tokenMode } : {}),
    });
    if (!built.ok) return fail({ message: built.message });
    const signature = carriedForkSignature({
      sourceEnvironmentId,
      sourceThreadId: sourceThreadRef.threadId,
      sourceMessageId: request.sourceMessageId,
      targetEnvironmentId: target.environmentId,
      projectId: target.projectId,
      baseRef: branch?.kind === "ready" ? branch.baseRef : null,
    });
    const input = buildCarriedForkInput({
      forkKey: carriedForkKey(signature, mintForkKey),
      target,
      branch,
      history: built.history,
    });
    const api = readCarriedForkApi(readEnvironmentApi(target.environmentId));
    if (input === null || api === null)
      return fail({ message: THREAD_FORK_COPY.errors.unavailable });
    setPhase("sending");
    const outcome = await runCarriedFork({ api, input, assertMutationReady });
    settleCarriedForkKey(signature, outcome);
    if (outcome.status !== "succeeded") return fail(outcome);
    await opened(outcome.result, controller.signal);
  });

  const push = useEvent(async () => {
    const cwd = project && !isChat ? (shell?.worktreePath ?? project.cwd) : null;
    const api = readEnvironmentApi(sourceEnvironmentId);
    if (!cwd || !api || pushing) return;
    setPushing(true);
    const failure = await api.git
      .runStackedAction({ action: "push", actionId: randomUUID(), cwd }, {})
      .then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : "Git reported an error."),
      );
    setPushing(false);
    if (failure !== null) {
      setNotice({ tone: "error", title: "Couldn't push", message: failure, detail: null });
    }
  });

  const busyLabel =
    phase === "reading"
      ? CARRIED_FORK_COPY.busy.reading
      : phase === "sending"
        ? CARRIED_FORK_COPY.busy.creating(target?.label ?? "the other machine")
        : phase === "opening"
          ? THREAD_FORK_COPY.busy.opening
          : "";

  return (
    <>
      <DialogHeader>
        <div className="flex items-start gap-3 pe-8">
          <span
            aria-hidden
            className="grid size-9 shrink-0 place-items-center rounded-xl border border-primary/20 bg-primary/8 text-primary"
          >
            <GitForkIcon className="size-4.5" />
          </span>
          <div className="flex min-w-0 flex-col gap-1.5">
            <DialogTitle>{THREAD_FORK_COPY.dialogTitle}</DialogTitle>
            <DialogDescription>{CARRIED_FORK_COPY.otherMachineDescription}</DialogDescription>
          </div>
        </div>
      </DialogHeader>
      <DialogPanel>
        <form
          id={CARRIED_FORM_ID}
          noValidate
          aria-label={CARRIED_FORK_COPY.otherMachine}
          className="flex flex-col gap-5"
          data-carried-fork-phase={phase}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {props.machineSwitch}
          {notice ? (
            <div
              role="alert"
              className={cn(
                "rounded-xl border px-3 py-2.5 text-sm",
                notice.tone === "error"
                  ? "border-destructive/30 bg-destructive/6 text-destructive-foreground"
                  : "border-warning/30 bg-warning/6",
              )}
              data-testid="carried-fork-notice"
            >
              <p className="font-medium">{notice.title}</p>
              <p className="text-xs">{notice.message}</p>
              {notice.detail ? <p className="text-xs opacity-80">{notice.detail}</p> : null}
            </div>
          ) : null}
          <div className="flex flex-col gap-2">
            <span id="carried-fork-target-label" className="font-medium text-foreground text-sm">
              {CARRIED_FORK_COPY.targetHeading}
            </span>
            <RadioGroup
              value={target?.environmentId ?? ""}
              onValueChange={(value) => setChosen(value as EnvironmentId)}
              aria-labelledby="carried-fork-target-label"
              disabled={busy}
              className="flex flex-col gap-2"
            >
              {targets.map((entry) => (
                <RadioPrimitive.Root
                  key={entry.environmentId}
                  value={entry.environmentId}
                  disabled={!entry.enabled}
                  data-testid={`carried-fork-target-${entry.environmentId}`}
                  className={cn(
                    "relative flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-lg border px-3 py-2.5 text-left outline-none",
                    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                    "data-disabled:cursor-not-allowed data-disabled:opacity-60",
                    entry.environmentId === target?.environmentId
                      ? "border-primary bg-background shadow-sm ring-2 ring-primary/35"
                      : "border-border bg-background hover:border-foreground/20 hover:bg-muted/50",
                  )}
                >
                  <span className="text-sm font-medium text-foreground">{entry.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {!entry.enabled
                      ? entry.disabledReason
                      : entry.projectId === null
                        ? CARRIED_FORK_COPY.targetChat
                        : entry.instance
                          ? CARRIED_FORK_COPY.targetModel(
                              entry.instance.label,
                              shell && !isArchivedThreadStub(shell)
                                ? shell.modelSelection.model
                                : "",
                            )
                          : null}
                  </span>
                </RadioPrimitive.Root>
              ))}
            </RadioGroup>
          </div>
          {branch ? (
            <div className="flex items-center gap-3" data-testid="carried-fork-branch">
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                {carriedForkBranchLine(branch)}
              </p>
              {branch.kind === "unpushed" || branch.kind === "no-upstream" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy || pushing}
                  data-testid="carried-fork-push"
                  onClick={() => void push()}
                >
                  {pushing ? <Spinner className="size-3.5" /> : null}
                  Push
                </Button>
              ) : null}
            </div>
          ) : null}
          <label className="flex items-start gap-2.5 text-sm" data-testid="carried-fork-archive">
            <Checkbox
              checked={archiveAfter}
              disabled={busy}
              onCheckedChange={(checked) => setArchiveAfter(checked === true)}
            />
            <span className="flex flex-col gap-0.5">
              <span>{CARRIED_FORK_COPY.archiveOriginal}</span>
              <span className="text-xs text-muted-foreground">
                {CARRIED_FORK_COPY.archiveOriginalDescription}
              </span>
            </span>
          </label>
          <p className="text-xs text-muted-foreground" data-testid="carried-fork-stays">
            {CARRIED_FORK_COPY.stays}
          </p>
        </form>
      </DialogPanel>
      <DialogFooter className="sm:items-center">
        <p
          aria-live="polite"
          className="min-w-0 text-muted-foreground text-xs empty:hidden sm:me-auto max-sm:order-last"
          data-testid="carried-fork-status"
        >
          {busyLabel}
        </p>
        <Button
          type="button"
          variant="outline"
          disabled={phase === "sending"}
          onClick={() => {
            abort.current?.abort();
            closeForkThreadDialog();
          }}
        >
          {THREAD_FORK_COPY.cancel}
        </Button>
        <Button
          type="submit"
          form={CARRIED_FORM_ID}
          data-testid="carried-fork-submit"
          disabled={busy || !sendable}
        >
          {busy ? (
            <>
              <Spinner className="size-3.5" />
              {busyLabel}
            </>
          ) : canRetry ? (
            THREAD_FORK_COPY.retry
          ) : (
            THREAD_FORK_COPY.submit
          )}
        </Button>
      </DialogFooter>
    </>
  );
}
