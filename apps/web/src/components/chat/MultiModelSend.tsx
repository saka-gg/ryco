// FILE: MultiModelSend.tsx
// Purpose: The composer's "Compare models" surfaces: the confirmation before a
//          send starts one thread and worktree per model, and the banner that
//          reports each model's outcome with Open and Retry.
// Layer: Web UI. The send itself is `hooks/executeMultiModelSend.ts`; the
//        outcomes come from the draft's tracker (`multiModelSendStore`).

import {
  captureReviewedSendReadiness,
  modelMultiSelectKey,
  summarizeMultiModelSend,
  type MultiModelSendTargetState,
  type MultiModelSendTargetStatus,
  type ProviderInstanceEntry,
} from "@ryco/client-runtime/state/composer";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { EnvironmentId, ModelSelection, ScopedThreadRef, ThreadId } from "@ryco/contracts";
import { CheckIcon, CircleAlertIcon, CircleHelpIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";

import { paneGrid } from "../../chatPanes.logic";
import { useChatPanesStore } from "../../chatPanesStore";
import type { DraftId } from "../../composerDraftStore";
import { readEnvironmentApi } from "../../environmentApi";
import { readEnvironmentConnection } from "../../environments/runtime";
import { MULTI_MODEL_SEND_CONNECTION_CHANGED_MESSAGE } from "../../hooks/executeMultiModelSend";
import { cn } from "../../lib/utils";
import { selectSidebarThreadSummaryByRef, useStore } from "../../store";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { getTriggerDisplayModelName } from "./providerIconUtils";
import { readMultiModelSend, setMultiModelSend, useMultiModelSend } from "./multiModelSendStore";

const countOf = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

interface TargetLabel {
  readonly key: string;
  readonly name: string;
  readonly entry: ProviderInstanceEntry | undefined;
}

function describeTarget(
  selection: Pick<ModelSelection, "instanceId" | "model">,
  entries: ReadonlyArray<ProviderInstanceEntry>,
): TargetLabel {
  const entry = entries.find((candidate) => candidate.instanceId === selection.instanceId);
  const model = entry?.models.find((candidate) => candidate.slug === selection.model);
  return {
    key: modelMultiSelectKey(selection),
    name: model ? getTriggerDisplayModelName(model) : selection.model,
    entry,
  };
}

function TargetName({ label }: { readonly label: TargetLabel }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {label.entry ? (
        <ProviderInstanceIcon
          driverKind={label.entry.driverKind}
          displayName={label.entry.displayName}
          accentColor={label.entry.accentColor}
          showBadge={false}
          className="size-4"
          iconClassName="size-3.5"
        />
      ) : null}
      <span className="truncate font-medium text-foreground">{label.name}</span>
    </span>
  );
}

export interface MultiModelSendConfirmation {
  readonly selections: ReadonlyArray<ModelSelection>;
  readonly baseBranch: string;
  /** The project has a setup script that runs in a new worktree. */
  readonly runsSetupScript: boolean;
}

/**
 * Asks before a send starts several threads at once: how many, where their
 * worktrees start, and that usage adds up.
 */
export function MultiModelSendConfirmDialog(props: {
  readonly confirmation: MultiModelSendConfirmation | null;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const { confirmation } = props;
  const count = confirmation?.selections.length ?? 0;
  const models = countOf(count, "model");
  return (
    <AlertDialog
      open={confirmation !== null}
      onOpenChange={(open) => {
        if (!open) props.onCancel();
      }}
    >
      <AlertDialogPopup className="max-w-md" data-testid="multi-model-send-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>Send to {models}?</AlertDialogTitle>
          <AlertDialogDescription>
            {count === 1 ? "It starts a new thread" : "Each model starts its own thread"} in a new
            worktree from{" "}
            <span className="font-mono text-foreground">{confirmation?.baseBranch}</span>.
            {confirmation?.runsSetupScript
              ? ` The setup script runs in ${count === 1 ? "it" : "each"}.`
              : ""}
            {count === 1 ? "" : " Every model works on the prompt separately, so usage adds up."}
          </AlertDialogDescription>
          <ul className="mt-2 grid gap-1.5 text-sm" aria-label="Models">
            {(confirmation?.selections ?? []).map((selection) => {
              const label = describeTarget(selection, props.entries);
              return (
                <li key={label.key}>
                  <TargetName label={label} />
                </li>
              );
            })}
          </ul>
        </AlertDialogHeader>
        <AlertDialogFooter variant="bare">
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button autoFocus onClick={props.onConfirm}>
            Send to {models}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** Whether the client sees the target's first turn: its thread has a user message. */
function turnVisibleIn(
  state: ReturnType<typeof useStore.getState>,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): boolean {
  return (
    selectSidebarThreadSummaryByRef(state, scopeThreadRef(environmentId, threadId))
      ?.latestUserMessageAt != null
  );
}

const subscribeNothing = () => () => {};
const readNothing = () => null;

function statusText(status: MultiModelSendTargetStatus): string {
  switch (status.kind) {
    case "pending":
    case "dispatching":
      return "Starting…";
    case "started":
      return "Started";
    case "not-created":
      return `Didn't start: ${status.message}`;
    case "uncertain":
      return "Not confirmed";
  }
}

function StatusIcon({ status }: { readonly status: MultiModelSendTargetStatus }) {
  const className = "size-3.5 shrink-0";
  switch (status.kind) {
    case "pending":
    case "dispatching":
      return (
        <LoaderCircleIcon
          className={cn(className, "animate-spin text-muted-foreground motion-reduce:animate-none")}
        />
      );
    case "started":
      return <CheckIcon className={cn(className, "text-success")} />;
    case "not-created":
      return <XIcon className={cn(className, "text-destructive")} />;
    case "uncertain":
      return <CircleHelpIcon className={cn(className, "text-warning")} />;
  }
}

/**
 * The banner for a draft's latest multi-model send: one row per model with its
 * outcome. A started thread opens from its row, and all of them side by side
 * in the split layout (up to four, `paneGrid`). An unconfirmed model offers
 * Open (check it first) and Retry, which sends the identical command again and
 * so can never start a second thread. Returns null without a send.
 */
export function useMultiModelSendBannerItem(input: {
  readonly draftId: DraftId | null;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly dispatchAllowed: boolean;
  /** Opens a thread in this view (the route follows the focused pane). */
  readonly openThread: (ref: ScopedThreadRef) => void;
}): ComposerBannerStackItem | null {
  const { draftId, entries, dispatchAllowed, openThread } = input;
  const record = useMultiModelSend(draftId);
  const tracker = record?.tracker ?? null;
  const snapshot = useSyncExternalStore(
    tracker?.subscribe ?? subscribeNothing,
    tracker?.read ?? readNothing,
  );
  const environmentId = record?.environmentId ?? null;
  // An unconfirmed model whose turn shows up in the shell has started.
  const uncertainVisible = useStore((state) =>
    snapshot && environmentId
      ? snapshot.targets.some(
          (target) =>
            target.status.kind === "uncertain" &&
            turnVisibleIn(state, environmentId, target.plan.threadId),
        )
      : false,
  );
  useEffect(() => {
    if (!uncertainVisible || !tracker || !environmentId) return;
    tracker.reconcile((target) =>
      turnVisibleIn(useStore.getState(), environmentId, target.threadId),
    );
  }, [environmentId, tracker, uncertainVisible]);

  if (!draftId || !record || !tracker || !snapshot || !environmentId) return null;
  const summary = summarizeMultiModelSend(snapshot);
  const total = snapshot.targets.length;
  const settling = summary.unsettled.length > 0 || record.sending;
  const refOf = (target: MultiModelSendTargetState) =>
    scopeThreadRef(environmentId, target.plan.threadId);
  const startedRefs = summary.started.map(refOf);

  const retry = async (target: MultiModelSendTargetState) => {
    const api = readEnvironmentApi(environmentId);
    const after = api
      ? await tracker.retryUncertain(target.plan.key, {
          api,
          assertMutationReady: captureReviewedSendReadiness(
            environmentId,
            () => readEnvironmentConnection(environmentId),
            MULTI_MODEL_SEND_CONNECTION_CHANGED_MESSAGE,
          ),
          turnVisible: (plan) => turnVisibleIn(useStore.getState(), environmentId, plan.threadId),
        })
      : null;
    // The tracker keeps the very same status when the retry did not go out or
    // the node did not take it: say so instead of leaving the click unanswered.
    const status = after?.targets.find((entry) => entry.plan.key === target.plan.key)?.status;
    if (status === undefined || status === target.status) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Still not confirmed",
          description:
            "The retry did not go through. Open the thread to check, or reconnect and retry.",
        }),
      );
    }
  };
  const openSideBySide = () => {
    const root = paneGrid(startedRefs);
    if (!root || !startedRefs[0]) return;
    if (startedRefs.length > 1) useChatPanesStore.getState().setRoot(root);
    openThread(startedRefs[0]);
  };

  const notes: string[] = [];
  if (!settling && summary.notCreated.length > 0) {
    notes.push(
      summary.notCreated.length === total
        ? "Your prompt is back in the composer. Send again to retry."
        : "The models that didn't start are selected again with your prompt. Send to retry them.",
    );
  }
  if (summary.uncertain.length > 0) {
    notes.push("Open a thread that isn't confirmed to check it before you retry.");
  }

  return {
    id: `multi-model-send:${snapshot.submissionId}`,
    variant: settling
      ? "info"
      : summary.started.length === total
        ? "success"
        : summary.started.length === 0 && summary.uncertain.length === 0
          ? "error"
          : "warning",
    icon: settling ? (
      <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
    ) : summary.started.length === total ? (
      <CheckIcon />
    ) : (
      <CircleAlertIcon />
    ),
    title: settling
      ? `Starting ${countOf(record.sending ? total : summary.unsettled.length, "model")}…`
      : summary.started.length === total
        ? `Started ${countOf(total, "thread")}`
        : `${summary.started.length} of ${total} started`,
    description: (
      <div className="mt-1 grid gap-1" data-slot="multi-model-send-targets">
        {snapshot.targets.map((target) => {
          const label = describeTarget(target.plan.modelSelection, entries);
          const status = target.status;
          return (
            <div
              key={target.plan.key}
              className="flex min-w-0 items-center gap-2"
              data-multi-model-target={label.key}
              data-status={status.kind}
            >
              <StatusIcon status={status} />
              <TargetName label={label} />
              <span
                className="min-w-0 flex-1 truncate text-muted-foreground"
                title={status.kind === "not-created" ? status.message : undefined}
              >
                {statusText(status)}
              </span>
              {status.kind === "started" || status.kind === "uncertain" ? (
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`Open ${label.name}`}
                  onClick={() => openThread(refOf(target))}
                >
                  Open
                </Button>
              ) : null}
              {status.kind === "uncertain" ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!dispatchAllowed}
                  aria-label={`Retry ${label.name}`}
                  onClick={() => void retry(target)}
                >
                  Retry
                </Button>
              ) : null}
            </div>
          );
        })}
        {notes.map((note) => (
          <span key={note} className="text-muted-foreground">
            {note}
          </span>
        ))}
      </div>
    ),
    actions:
      startedRefs.length > 1 ? (
        <Button size="xs" onClick={openSideBySide}>
          Open side by side
        </Button>
      ) : undefined,
    ...(settling
      ? {}
      : {
          dismissLabel: "Dismiss",
          onDismiss: () => {
            // A newer send of the draft keeps its own banner.
            if (readMultiModelSend(draftId)?.tracker === tracker) setMultiModelSend(draftId, null);
          },
        }),
  };
}
