// FILE: MultiModelSend.tsx
// Purpose: The composer's "Compare models" surfaces: the confirmation before a
//          send starts one thread and worktree per model, and the banners that
//          report each model's outcome with Open, Retry and Send as new.
// Layer: Web UI. The send itself is `hooks/executeMultiModelSend.ts`; the
//        outcomes come from the draft's trackers (`multiModelSendStore`).

import {
  captureReviewedSendReadiness,
  describeModelMultiSelectTarget,
  summarizeMultiModelSend,
  type ModelMultiSelectTargetLabel,
  type MultiModelSendSnapshot,
  type MultiModelSendTargetState,
  type MultiModelSendTargetStatus,
  type ProviderInstanceEntry,
} from "@ryco/client-runtime/state/composer";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import type {
  EnvironmentId,
  ModelSelection,
  ProviderInstanceId,
  ScopedThreadRef,
  ThreadId,
} from "@ryco/contracts";
import type { ModelPresentationOption } from "@ryco/shared/model";
import { CheckIcon, CircleAlertIcon, CircleHelpIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import { paneGrid } from "../../chatPanes.logic";
import { useChatPanesStore } from "../../chatPanesStore";
import type { DraftId } from "../../composerDraftStore";
import { readEnvironmentApi } from "../../environmentApi";
import { readEnvironmentConnection } from "../../environments/runtime";
import {
  MULTI_MODEL_SEND_CONNECTION_CHANGED_MESSAGE,
  type SendMultiModelTargetAsNewResult,
} from "../../hooks/executeMultiModelSend";
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
import {
  removeMultiModelSend,
  useMultiModelSends,
  type MultiModelSendRecord,
} from "./multiModelSendStore";

const countOf = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** What names a compared model: the composer's catalog and the models it offers per instance. */
export interface MultiModelSendCatalog {
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<
    ProviderInstanceId,
    ReadonlyArray<ModelPresentationOption>
  >;
}

function TargetName({ label }: { readonly label: ModelMultiSelectTargetLabel }) {
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
  /** Whether the project's setup script runs in each new worktree (`multiModelSendRunsSetupScript`). */
  readonly runsSetupScript: "yes" | "no" | "maybe";
}

function setupScriptNote(runs: MultiModelSendConfirmation["runsSetupScript"], count: number) {
  const where = count === 1 ? "it" : "each";
  if (runs === "yes") return ` The setup script runs in ${where}.`;
  if (runs === "maybe")
    return ` The setup script may run in ${where}, as the project's settings say.`;
  return "";
}

/**
 * Asks before a send starts several threads at once: how many, where their
 * worktrees start, and that usage adds up.
 */
export function MultiModelSendConfirmDialog(props: {
  readonly confirmation: MultiModelSendConfirmation | null;
  readonly catalog: MultiModelSendCatalog;
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
            {confirmation ? setupScriptNote(confirmation.runsSetupScript, count) : ""}
            {count === 1 ? "" : " Every model works on the prompt separately, so usage adds up."}
          </AlertDialogDescription>
          <ul className="mt-2 grid gap-1.5 text-sm" aria-label="Models">
            {(confirmation?.selections ?? []).map((selection) => {
              const label = describeModelMultiSelectTarget(selection, props.catalog);
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
      return status.retryRefusal === undefined ? "Not confirmed" : "Not confirmed, retry refused";
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

const NO_SNAPSHOTS: ReadonlyArray<MultiModelSendSnapshot> = [];

/** Each send's live snapshot, in order; the same array while none of them changed. */
function useMultiModelSendSnapshots(
  records: ReadonlyArray<MultiModelSendRecord>,
): ReadonlyArray<MultiModelSendSnapshot> {
  const cache = useRef(NO_SNAPSHOTS);
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribes = records.map((record) => record.tracker.subscribe(listener));
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
    [records],
  );
  const read = useCallback(() => {
    const next = records.map((record) => record.tracker.read());
    const previous = cache.current;
    if (
      next.length === previous.length &&
      next.every((snapshot, index) => snapshot === previous[index])
    ) {
      return previous;
    }
    cache.current = next;
    return next;
  }, [records]);
  return useSyncExternalStore(subscribe, read, read);
}

interface MultiModelSendBannerInput {
  readonly draftId: DraftId | null;
  readonly catalog: MultiModelSendCatalog;
  readonly dispatchAllowed: boolean;
  /** Opens a thread in this view (the route follows the focused pane). */
  readonly openThread: (ref: ScopedThreadRef) => void;
  /** `sendMultiModelTargetAsNew` with the composer's deps. */
  readonly sendAsNew: (
    record: MultiModelSendRecord,
    key: string,
  ) => SendMultiModelTargetAsNewResult;
}

/**
 * One banner per multi-model send of the draft that is still worth showing:
 * the latest one, and every earlier one with a model not confirmed. Each has
 * one row per model with its outcome. A started thread opens from its row, and
 * all of them side by side in the split layout (up to four, `paneGrid`). An
 * unconfirmed model offers Open (check it first) and Retry, which sends the
 * identical command again and so can never start a second thread; once the
 * node refused that retry, Send as new puts the prompt back for that model.
 */
export function useMultiModelSendBannerItems(
  input: MultiModelSendBannerInput,
): ReadonlyArray<ComposerBannerStackItem> {
  const records = useMultiModelSends(input.draftId);
  const snapshots = useMultiModelSendSnapshots(records);
  // An unconfirmed model whose turn shows up in the shell has started.
  const uncertainVisible = useStore((state) =>
    snapshots.some((snapshot, index) =>
      snapshot.targets.some(
        (target) =>
          target.status.kind === "uncertain" &&
          turnVisibleIn(state, records[index]!.environmentId, target.plan.threadId),
      ),
    ),
  );
  useEffect(() => {
    if (!uncertainVisible) return;
    for (const record of records) {
      record.tracker.reconcile((target) =>
        turnVisibleIn(useStore.getState(), record.environmentId, target.threadId),
      );
    }
  }, [records, uncertainVisible]);

  const { draftId } = input;
  if (!draftId) return [];
  return records.flatMap((record, index) => {
    const snapshot = snapshots[index];
    return snapshot && snapshot.targets.length > 0
      ? [multiModelSendBannerItem({ ...input, draftId, record, snapshot })]
      : [];
  });
}

function multiModelSendBannerItem(
  input: MultiModelSendBannerInput & {
    readonly draftId: DraftId;
    readonly record: MultiModelSendRecord;
    readonly snapshot: MultiModelSendSnapshot;
  },
): ComposerBannerStackItem {
  const { draftId, record, snapshot, catalog, dispatchAllowed, openThread } = input;
  const { tracker, environmentId } = record;
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
    const status = after?.targets.find((entry) => entry.plan.key === target.plan.key)?.status;
    if (status?.kind === "uncertain" && status !== target.status && status.retryRefusal) {
      // The node answered, and sending the same request again cannot help.
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Ryco refused the retry",
          description: `${status.retryRefusal} Open the thread to check it. If it has no reply, choose Send as new.`,
        }),
      );
    } else if (status === undefined || status === target.status) {
      // The tracker keeps the very same status when the retry did not go out:
      // say so instead of leaving the click unanswered.
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
  const sendAsNew = (target: MultiModelSendTargetState) => {
    if (input.sendAsNew(record, target.plan.key) !== "composer-not-empty") return;
    toastManager.add(
      stackedThreadToast({
        type: "info",
        title: "The composer isn't empty",
        description: "Send or clear what's in it first, then choose Send as new again.",
      }),
    );
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
    notes.push(
      summary.uncertain.some(
        (target) => target.status.kind === "uncertain" && target.status.retryRefusal,
      )
        ? "Open a thread that isn't confirmed to check it. If it has no reply, Send as new puts your prompt back for that model."
        : "Open a thread that isn't confirmed to check it before you retry.",
    );
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
          const label = describeModelMultiSelectTarget(target.plan.modelSelection, catalog);
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
                title={
                  status.kind === "not-created"
                    ? status.message
                    : status.kind === "uncertain"
                      ? status.retryRefusal
                      : undefined
                }
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
              {status.kind === "uncertain" && status.retryRefusal !== undefined ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={record.sending}
                  aria-label={`Send ${label.name} as new`}
                  onClick={() => sendAsNew(target)}
                >
                  Send as new
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
          onDismiss: () => removeMultiModelSend(draftId, tracker),
        }),
  };
}
