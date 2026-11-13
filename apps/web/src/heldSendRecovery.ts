import { parseScopedThreadKey } from "@ryco/client-runtime/scoped";
import {
  appendReturnedComposerPrompt,
  composerTargetKey,
  decodeComposerReferenceDraft,
  DraftId,
} from "@ryco/client-runtime/state/composer";
import {
  readQueueThreadView,
  resolveHeldSendRecovery,
  selectThreadFollowUpQueue,
} from "@ryco/client-runtime/state/message-queue";
import type { ScopedThreadRef } from "@ryco/contracts";

import {
  ensureComposerDraftAttachmentsRestored,
  useComposerDraftStore,
} from "./composerDraftStore";
import { hydrateDraftImagesFromPersisted } from "./composerDraftPersistence";
import { stackedThreadToast, toastManager } from "./components/ui/toast";
import { retainThreadDetailSubscription } from "./environments/runtime/service";
import type { TerminalContextDraft } from "./lib/terminalContext";
import {
  readWebQueueEnvironment,
  subscribeWebQueueEnvironmentReadiness,
} from "./messageQueueEnvironment";
import { updateHeldSendRecords, type HeldSendRecord } from "./heldSendRecords";
import { useStore } from "./store";

// ---------------------------------------------------------------------------
// After a reload or a closed tab: a message that was waiting for its uploads
// either already went out or comes back into its draft (`heldSends.ts`).
// ---------------------------------------------------------------------------

/**
 * Settles one leftover record once: drops it when the thread already has the message (sent, or
 * queued on the node), otherwise puts the message back into its draft. `onSettled` runs after.
 */
export function recoverHeldSend(record: HeldSendRecord, onSettled: () => void): void {
  const ref = parseScopedThreadKey(record.threadKey);
  if (!ref) {
    updateHeldSendRecords((records) => records.filter((r) => r.messageId !== record.messageId));
    onSettled();
    return;
  }
  let releaseDetail: (() => void) | null = null;
  let done = false;
  const stops: Array<() => void> = [];
  const finish = (restore: boolean) => {
    if (done) return;
    done = true;
    for (const stop of stops) stop();
    releaseDetail?.();
    if (restore) restoreRecordIntoDraft(record, ref);
    updateHeldSendRecords((records) => records.filter((r) => r.messageId !== record.messageId));
    onSettled();
  };
  const evaluate = () => {
    if (done) return;
    const state = useStore.getState();
    const environment = readWebQueueEnvironment(ref.environmentId, state);
    const decision = resolveHeldSendRecovery({
      messageId: record.messageId,
      shellLive: environment.shellLive,
      view: readQueueThreadView(state, ref),
      serverQueueMessageIds: new Set(
        selectThreadFollowUpQueue(state, ref)?.entries.map((entry) => entry.messageId) ?? [],
      ),
    });
    if (decision === "sent") finish(false);
    else if (decision === "restore") finish(true);
    else if (decision === "load-detail" && releaseDetail === null && environment.mutationReady) {
      releaseDetail = retainThreadDetailSubscription(ref.environmentId, ref.threadId);
    }
  };
  stops.push(useStore.subscribe(evaluate), subscribeWebQueueEnvironmentReadiness(evaluate));
  evaluate();
}

function isTerminalContextDraft(value: unknown): value is TerminalContextDraft {
  if (typeof value !== "object" || value === null) return false;
  const context = value as Record<string, unknown>;
  return (
    typeof context.id === "string" &&
    typeof context.threadId === "string" &&
    typeof context.terminalId === "string" &&
    typeof context.terminalLabel === "string" &&
    typeof context.lineStart === "number" &&
    typeof context.lineEnd === "number" &&
    typeof context.text === "string" &&
    typeof context.createdAt === "string"
  );
}

/** Puts a message that never went out back into its draft, after what the draft holds. */
function restoreRecordIntoDraft(record: HeldSendRecord, ref: ScopedThreadRef): void {
  const target: ScopedThreadRef | DraftId =
    record.draftTarget.kind === "draft" ? DraftId.make(record.draftTarget.draftId) : ref;
  const drafts = useComposerDraftStore.getState();
  const current = drafts.draftsByThreadKey[composerTargetKey(target)];
  drafts.setPrompt(target, appendReturnedComposerPrompt(current?.prompt ?? "", record.prompt));
  const images = hydrateDraftImagesFromPersisted(record.attachments);
  if (images.length > 0) drafts.addImages(target, images);
  const contexts = record.terminalContexts.filter(isTerminalContextDraft);
  if (contexts.length > 0) {
    drafts.setTerminalContexts(target, [...(current?.terminalContexts ?? []), ...contexts]);
  }
  const references = record.fileReferences.flatMap((value) => {
    const decoded = decodeComposerReferenceDraft(value);
    return decoded ? [decoded] : [];
  });
  if (references.length > 0) {
    drafts.setFileReferences(target, [...(current?.fileReferences ?? []), ...references]);
  }
  void ensureComposerDraftAttachmentsRestored();
  toastManager.add(
    stackedThreadToast({
      type: "info",
      title: "Message back in its draft",
      description:
        "A message that was waiting for its uploads did not go out before the page closed.",
    }),
  );
}
