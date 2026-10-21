// FILE: ForkThreadDialog.tsx
// Purpose: "Fork from here": choose where a new thread that inherits this
//          conversation up to the selected reply works (its checkout), send one
//          idempotent `threads.fork`, then open the fork.
// Layer: Web UI (desktop and tablet; the frozen phone tier never opens it). The
//        app's one instance is mounted lazily by `RootAppShell` and opened
//        through `forkThreadDialogStore.ts`. The attempt (its key, lock,
//        retries, outcomes and lifecycle: `createThreadForkAttemptController`),
//        destinations, copy and the guarded call are the shared client
//        runtime's (`@ryco/client-runtime/state/threads`), as in the native
//        app; this file only renders them. The node decides everything.
// Motion: the dialog grows out of the reply's fork button and folds back into it.

import { scopeProjectRef, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { captureReviewedSendReadiness } from "@ryco/client-runtime/state/composer";
import {
  alignThreadForkSelection,
  createThreadForkAttemptController,
  createThreadForkKey,
  defaultThreadForkBaseRef,
  defaultThreadForkOption,
  isThreadForkAttemptDismissible,
  listThreadForkDestinations,
  listThreadForkWorktreeStarts,
  resolveThreadForkApi,
  resolveThreadForkSourceGit,
  THREAD_FORK_COPY,
  threadForkAttemptView,
  threadForkReplyExcerpt,
  threadForkShellPorts,
  type ThreadForkAttemptControllerPorts,
  type ThreadForkAttemptNotice,
  type ThreadForkOption,
  type ThreadForkSelection,
} from "@ryco/client-runtime/state/threads";
import {
  WS_METHODS,
  type EnvironmentId,
  type ThreadForkKey,
  type ThreadForkResult,
} from "@ryco/contracts";
import { isChatProject } from "@ryco/shared/projectKind";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangleIcon, GitForkIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { readEnvironmentConnection } from "../../environments/runtime";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { useHostedHubStore } from "../../hostedHub/state";
import { hostedCapabilityCopy, hostedSwitchTargetLabel } from "../../hostedHub/switchTarget";
import { useChatsAvailability } from "../../hooks/useChatsAvailability";
import { useEvent } from "../../hooks/useEvent";
import { useGitStatus } from "../../lib/gitStatusState";
import { cn, randomUUID } from "../../lib/utils";
import { selectEnvironmentState, selectProjectByRef, useStore, type AppState } from "../../store";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { RadioGroup } from "../ui/radio-group";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { forkDialogNotices, forkSourceGitCwd } from "./ForkThreadDialog.logic";
import {
  closeForkThreadDialog,
  type ForkThreadDialogRequest,
  useForkThreadDialogStore,
} from "./forkThreadDialogStore";

const FORK_FORM_ID = "fork-thread-form";
const FORK_BASE_REF_INPUT_ID = "fork-thread-base-ref";

function mintForkKey(): ThreadForkKey {
  return createThreadForkKey(() => randomUUID().replaceAll("-", ""));
}

/** The browser's side of one fork dialog on one environment. */
function webForkDialogPorts(environmentId: EnvironmentId): ThreadForkAttemptControllerPorts {
  return {
    mintKey: mintForkKey,
    captureReadiness: () =>
      captureReviewedSendReadiness(
        environmentId,
        () => readEnvironmentConnection(environmentId),
        THREAD_FORK_COPY.connectionChanged,
      ),
    resolveApi: () => resolveThreadForkApi(() => readEnvironmentApi(environmentId)),
    ...threadForkShellPorts(environmentId),
  };
}

/* ───────── Host ───────── */

/** The app's one fork dialog. Mount once; open it with `openForkThreadDialog`. */
export function ForkThreadDialog() {
  const open = useForkThreadDialogStore((state) => state.open);
  const token = useForkThreadDialogStore((state) => state.token);
  const request = useForkThreadDialogStore((state) => state.request);
  const origin = useForkThreadDialogStore((state) => state.origin);
  // While a request is in flight the dialog stays: its outcome decides what happens next.
  const busyRef = useRef(false);
  const handleBusyChange = useEvent((busy: boolean) => {
    busyRef.current = busy;
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busyRef.current) closeForkThreadDialog();
      }}
    >
      <DialogPopup
        className="max-w-lg"
        data-testid="fork-thread-dialog"
        bottomStickOnMobile={false}
        morph={origin ? { origin: () => origin } : "auto"}
      >
        {request ? (
          <ForkThreadDialogBody key={token} request={request} onBusyChange={handleBusyChange} />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

/* ───────── Body ───────── */

function ForkThreadDialogBody(props: {
  readonly request: ForkThreadDialogRequest;
  readonly onBusyChange: (busy: boolean) => void;
}) {
  const { request, onBusyChange } = props;
  const { sourceThreadRef } = request;
  const environmentId = sourceThreadRef.environmentId;
  const navigate = useNavigate();

  const shell = useStore(
    useMemo(
      () => (state: AppState) =>
        selectEnvironmentState(state, environmentId).threadShellById[sourceThreadRef.threadId],
      [environmentId, sourceThreadRef.threadId],
    ),
  );
  const projectId = shell?.projectId ?? null;
  const project = useStore(
    useMemo(
      () => (state: AppState) =>
        projectId
          ? selectProjectByRef(state, scopeProjectRef(environmentId, projectId))
          : undefined,
      [environmentId, projectId],
    ),
  );
  const isChat = project ? isChatProject(project) : false;
  const sourceWorktreePath = shell?.worktreePath ?? null;
  const sourceBranch = shell?.branch ?? null;
  // The project root decides, as on the node: a removed source worktree must not hide one.
  const gitStatus = useGitStatus({ environmentId, cwd: forkSourceGitCwd({ project, isChat }) });
  const isGitRepo = project ? resolveThreadForkSourceGit({ isChat, status: gitStatus }) : null;
  const chatsAvailable = useChatsAvailability(environmentId).available;
  const capability = useHostedRpcCapability(WS_METHODS.threadsFork, environmentId);
  const nodeLabel = useHostedHubStore((state) => hostedSwitchTargetLabel(state, environmentId));

  const destinations = useMemo(
    () =>
      listThreadForkDestinations({
        isChat,
        isGitRepo,
        chatsAvailable,
        sourceWorktreePath,
        sourceBranch,
      }),
    [chatsAvailable, isChat, isGitRepo, sourceBranch, sourceWorktreePath],
  );

  // Opens the created fork: a new history entry, so Back returns to the source.
  // Opening a thread the shell has not delivered yet would bounce off the route,
  // so a fork that is still on its way is announced with a link instead.
  const openFork = useEvent((result: ThreadForkResult, arrived: boolean) => {
    const forkRef = scopeThreadRef(environmentId, result.threadId);
    const open = () => {
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(forkRef) });
    };
    onBusyChange(false);
    closeForkThreadDialog();
    if (arrived) {
      open();
      return;
    }
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: "Fork created",
        description: "It will appear in the sidebar once this machine syncs it.",
        actionProps: { children: "Open fork", onClick: open },
      }),
    );
  });

  // One attempt per reply: reopening the dialog for a reply whose fork may
  // still exist on the node continues that attempt (same key, same locked
  // request, possibly still in flight), and one whose fork was created while no
  // dialog showed it opens that fork, instead of starting a second one (or
  // starts over when that fork was deleted since).
  const [controller] = useState(() => {
    const defaultBaseRef = defaultThreadForkBaseRef(sourceBranch);
    return createThreadForkAttemptController({
      boundary: {
        environmentId,
        sourceThreadId: sourceThreadRef.threadId,
        sourceMessageId: request.sourceMessageId,
      },
      initialSelection: {
        destination: defaultThreadForkOption(destinations)?.kind ?? "current-checkout",
        baseRef: defaultBaseRef,
      },
      defaultBaseRef,
      ports: webForkDialogPorts(environmentId),
      onForked: (result, arrived) => openFork(result, arrived),
    });
  });
  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const { attempt, opening } = snapshot;

  const worktreeStarts = useMemo(
    () =>
      listThreadForkWorktreeStarts({
        checkpointAvailable: request.checkpointAvailable && !attempt.checkpointRefused,
      }),
    [attempt.checkpointRefused, request.checkpointAvailable],
  );
  const shown = useMemo(
    () => alignThreadForkSelection(attempt, { destinations, worktreeStarts }),
    [attempt, destinations, worktreeStarts],
  );
  const view = threadForkAttemptView(shown);
  const { selection } = shown;
  // A locked attempt resends its own request whatever the options say now.
  const selectionSendable =
    view.locked ||
    destinations.some((option) => option.kind === selection.destination && option.enabled);

  // Why the selection cannot be sent, shown once a submit tried it.
  const [showSelectionError, setShowSelectionError] = useState(false);

  // A request in flight, and opening the fork it created, keep the dialog up. Opening a fork
  // created while no dialog showed it can be cancelled.
  const busy = !isThreadForkAttemptDismissible(snapshot);
  const working = busy || opening;
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  const sourceMissing = shell === undefined;
  const blocked = sourceMissing
    ? THREAD_FORK_COPY.errors["source-unavailable"]
    : capability.hosted && !capability.allowed
      ? (hostedCapabilityCopy(capability, nodeLabel) ?? THREAD_FORK_COPY.refusedForbidden)
      : null;

  const edit = useEvent((patch: Partial<ThreadForkSelection>) => {
    controller.select(patch);
    setShowSelectionError(false);
  });

  // Fork, Retry and Check again: the shared attempt decides the request, its
  // key and which connection it is checked against.
  const submit = useEvent(() => {
    if (busy || blocked !== null || !selectionSendable) return;
    const current = alignThreadForkSelection(controller.getSnapshot().attempt, {
      destinations,
      worktreeStarts,
    });
    const currentView = threadForkAttemptView(current);
    if (currentView.selectionError !== null) {
      setShowSelectionError(true);
      if (current.selection.destination === "new-worktree") {
        window.requestAnimationFrame(() =>
          document.getElementById(FORK_BASE_REF_INPUT_ID)?.focus(),
        );
      }
      return;
    }
    if (!currentView.canSubmit) return;
    setShowSelectionError(false);
    controller.submit(current.selection);
  });

  const excerpt = threadForkReplyExcerpt(request.boundaryText);
  const formDisabled = busy || !view.canEdit;
  const failureReason =
    attempt.failure && (attempt.phase === "failed" || attempt.phase === "running")
      ? attempt.failure.reason
      : undefined;
  const inlineError = showSelectionError ? view.selectionError : null;
  // A locked key that holds a request this client never sent offers nothing to send.
  const showPrimary =
    opening || attempt.phase === "submitting" || !(view.locked && !view.canSubmit);

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
            <DialogDescription>{THREAD_FORK_COPY.dialogDescription}</DialogDescription>
          </div>
        </div>
      </DialogHeader>
      <DialogPanel>
        <form
          id={FORK_FORM_ID}
          noValidate
          aria-label={THREAD_FORK_COPY.dialogTitle}
          className="flex flex-col gap-5"
          data-fork-attempt-phase={attempt.phase}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <figure
            className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-border/70 bg-muted/30 px-3 py-2.5"
            data-testid="fork-thread-boundary"
          >
            <figcaption className="truncate text-xs font-medium text-muted-foreground">
              {shell?.title ?? "Original thread"}
            </figcaption>
            <blockquote className="line-clamp-3 text-sm text-foreground/85">
              {excerpt.length > 0 ? excerpt : "(reply without text)"}
            </blockquote>
          </figure>

          {forkDialogNotices({ view, blocked }).map(({ kind, notice }) =>
            kind === "attempt" ? (
              <ForkNotice key={kind} notice={notice} reason={failureReason} />
            ) : (
              <ForkNotice key={kind} notice={notice} testId="fork-thread-blocked" />
            ),
          )}

          <ForkOptionGroup
            id="fork-thread-destination"
            heading={THREAD_FORK_COPY.destinationHeading}
            options={destinations}
            value={selection.destination}
            disabled={formDisabled}
            onChange={(destination) => edit({ destination })}
          />

          {selection.destination === "new-worktree" ? (
            <div className="flex flex-col gap-3">
              <ForkOptionGroup
                id="fork-thread-start"
                heading={THREAD_FORK_COPY.worktreeStartHeading}
                options={worktreeStarts}
                value={selection.worktreeStart ?? null}
                disabled={formDisabled}
                onChange={(worktreeStart) => edit({ worktreeStart })}
              />
              {selection.worktreeStart === "base-ref" ? (
                <div className="flex flex-col gap-1.5 ps-1">
                  <label
                    htmlFor={FORK_BASE_REF_INPUT_ID}
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {THREAD_FORK_COPY.worktreeStarts.baseRef}
                  </label>
                  <Input
                    id={FORK_BASE_REF_INPUT_ID}
                    value={selection.baseRef ?? ""}
                    required
                    disabled={formDisabled}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono text-xs"
                    aria-invalid={(showSelectionError && view.selectionError !== null) || undefined}
                    data-testid="fork-thread-base-ref"
                    onChange={(event) => edit({ baseRef: event.target.value })}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {inlineError ? (
            <p className="text-xs text-destructive-foreground" data-testid="fork-thread-invalid">
              {inlineError}
            </p>
          ) : null}

          <p className="text-xs text-muted-foreground" data-testid="fork-thread-provider-note">
            {THREAD_FORK_COPY.providerNote}
          </p>
        </form>
      </DialogPanel>
      <DialogFooter className="sm:items-center">
        <p
          aria-live="polite"
          className="min-w-0 text-muted-foreground text-xs empty:hidden sm:me-auto max-sm:order-last"
          data-testid="fork-thread-status"
        >
          {opening ? THREAD_FORK_COPY.busy.opening : view.busyLabel}
        </p>
        <Button
          type="button"
          variant="outline"
          data-testid="fork-thread-cancel"
          disabled={busy}
          onClick={() => closeForkThreadDialog()}
        >
          {THREAD_FORK_COPY.cancel}
        </Button>
        {showPrimary ? (
          <Button
            type="submit"
            form={FORK_FORM_ID}
            // Retry and Check again resend the exact request under the same key.
            data-testid={view.canRetry ? "fork-thread-retry" : "fork-thread-submit"}
            disabled={
              working ||
              blocked !== null ||
              !selectionSendable ||
              (!view.canSubmit && view.selectionError === null)
            }
          >
            {working ? (
              <>
                <Spinner className="size-3.5" />
                {opening ? THREAD_FORK_COPY.busy.opening : view.busyLabel}
              </>
            ) : (
              view.submitLabel
            )}
          </Button>
        ) : null}
      </DialogFooter>
    </>
  );
}

/* ───────── Pieces ───────── */

function ForkNotice(props: {
  readonly notice: ThreadForkAttemptNotice;
  readonly reason?: string | undefined;
  readonly testId?: string | undefined;
}) {
  const { notice } = props;
  return (
    <Alert
      variant={notice.tone}
      data-testid={props.testId ?? "fork-thread-notice"}
      data-reason={props.reason}
    >
      <AlertTriangleIcon aria-hidden />
      <AlertTitle>{notice.title}</AlertTitle>
      <AlertDescription>
        <span>{notice.message}</span>
        {notice.detail ? (
          <span data-testid="fork-thread-notice-detail">{notice.detail}</span>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

function ForkOptionGroup<Kind extends string>(props: {
  readonly id: string;
  readonly heading: string;
  readonly options: ReadonlyArray<ThreadForkOption<Kind>>;
  readonly value: Kind | null;
  readonly disabled: boolean;
  readonly onChange: (kind: Kind) => void;
}) {
  const labelId = `${props.id}-label`;
  return (
    <div className="flex flex-col gap-2">
      <span id={labelId} className="font-medium text-foreground text-sm">
        {props.heading}
      </span>
      <RadioGroup
        value={props.value ?? ""}
        onValueChange={(value) => props.onChange(value as Kind)}
        aria-labelledby={labelId}
        disabled={props.disabled}
        className="flex flex-col gap-2"
      >
        {props.options.map((option) => {
          const selected = option.kind === props.value;
          return (
            <RadioPrimitive.Root
              key={option.kind}
              value={option.kind}
              disabled={!option.enabled}
              data-testid={`${props.id}-${option.kind}`}
              className={cn(
                "relative flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-lg border px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                "data-disabled:cursor-not-allowed data-disabled:opacity-60",
                selected
                  ? "border-primary bg-background shadow-sm ring-2 ring-primary/35"
                  : "border-border bg-background hover:border-foreground/20 hover:bg-muted/50",
              )}
            >
              <span className="text-sm font-medium text-foreground">{option.label}</span>
              <span className="text-xs text-muted-foreground">
                {option.enabled
                  ? option.description
                  : (option.disabledReason ?? option.description)}
              </span>
            </RadioPrimitive.Root>
          );
        })}
      </RadioGroup>
    </div>
  );
}
