import {
  loadReturnedSentMessage,
  type ReturnableSentAttachment,
  type ReturnedSentMessage,
} from "@ryco/client-runtime/state/composer";
import { readAttachmentBytesFromTransport } from "@ryco/client-runtime/rpc";
import {
  EDIT_FROM_HERE_COPY,
  keptChangesRestoreNote,
  revertCheckpointGuardFailureMessage,
  runCheckpointRevert,
  type CheckpointRevertMode,
  type CheckpointRevertNotice,
  type CheckpointRevertThreadView,
} from "@ryco/client-runtime/state/session";
import type { ChatMessage } from "@ryco/client-runtime/state/threads";
import type { EnvironmentApi, EnvironmentId, ThreadId } from "@ryco/contracts";

import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import type { DraftComposerAttachment } from "../../lib/composerFiles";
import { newCommandId } from "../../lib/ids";
import { uuidv4 } from "../../lib/uuid";

// "Edit from here" on mobile, over the shared revert (`runCheckpointRevert`):
// the choice dialog, the sent message's attachments turned back into composer
// drafts (read before the revert is sent, because projecting it deletes the
// node's copies), and the returned messages held for their thread's screen.

/** Asks how far the revert goes; resolves null when cancelled. */
export function chooseCheckpointRevertMode(input: {
  readonly keepFilesAvailable: boolean;
  /** An earlier revert's checkpoint whose kept changes restoring would discard too. */
  readonly keptChangesTurnCount?: number | null | undefined;
}): Promise<CheckpointRevertMode | null> {
  const keptChanges =
    input.keptChangesTurnCount === null || input.keptChangesTurnCount === undefined
      ? ""
      : ` ${keptChangesRestoreNote(input.keptChangesTurnCount)}`;
  return new Promise((resolve) => {
    const onCancel = () => resolve(null);
    showConfirmDialog(
      input.keepFilesAvailable
        ? {
            title: EDIT_FROM_HERE_COPY.title,
            message: `${EDIT_FROM_HERE_COPY.description} ${EDIT_FROM_HERE_COPY.restoreFilesNote}${keptChanges}`,
            confirmText: EDIT_FROM_HERE_COPY.keepFiles,
            alternative: {
              text: EDIT_FROM_HERE_COPY.restoreFiles,
              destructive: true,
              onPress: () => resolve("restore-files"),
            },
            onConfirm: () => resolve("keep-files"),
            onCancel,
          }
        : {
            title: EDIT_FROM_HERE_COPY.title,
            message: `${EDIT_FROM_HERE_COPY.description} ${EDIT_FROM_HERE_COPY.restoreOnlyNote}${keptChanges}`,
            confirmText: EDIT_FROM_HERE_COPY.restoreOnly,
            destructive: true,
            onConfirm: () => resolve("restore-files"),
            onCancel,
          },
    );
  });
}

/** What one sent message returns to the composer with on mobile. */
export type ReturnedSentMessageDrafts = ReturnedSentMessage<DraftComposerAttachment>;

const BASE64_CHUNK_BYTES = 0x8000;

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES));
  }
  return btoa(binary);
}

/** Keeps a returned file in the app cache, where picked files live too, until it uploads. */
async function writeReturnedFile(name: string, bytes: Uint8Array): Promise<string> {
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.cache, "edit-from-here", uuidv4());
  directory.create({ intermediates: true, idempotent: true });
  const file = new File(directory, name);
  file.write(bytes);
  return file.uri;
}

export function loadSentMessageDrafts(input: {
  readonly message: Pick<ChatMessage, "text" | "attachments">;
  /** What the composer holds now; the returned attachments must fit next to it. */
  readonly composerAttachments: ReadonlyArray<{ readonly sizeBytes: number }>;
  /** The node streams file uploads; without it this app cannot attach files. */
  readonly fileUploadsSupported: boolean;
  readonly readBytes: (attachment: ReturnableSentAttachment) => Promise<Uint8Array>;
  readonly writeFile?: (name: string, bytes: Uint8Array) => Promise<string>;
}): Promise<ReturnedSentMessageDrafts> {
  const writeFile = input.writeFile ?? writeReturnedFile;
  return loadReturnedSentMessage<DraftComposerAttachment>({
    message: input.message,
    composerAttachments: input.composerAttachments,
    refuse: (attachments) =>
      !input.fileUploadsSupported && attachments.some((attachment) => attachment.type === "file")
        ? "This app can't attach this message's files on this machine."
        : null,
    load: async (attachment) => {
      const bytes = await input.readBytes(attachment);
      if (attachment.type === "image") {
        const dataUrl = `data:${attachment.mimeType};base64,${encodeBase64(bytes)}`;
        return {
          type: "image",
          id: uuidv4(),
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: bytes.length,
          dataUrl,
          previewUri: dataUrl,
        };
      }
      return {
        type: "file",
        id: uuidv4(),
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: bytes.length,
        readUri: await writeFile(attachment.name, bytes),
      };
    },
  });
}

// Returned messages wait here, by scoped thread key, until that thread's screen
// takes them into its composer: the screen may close while the node reverts,
// and the node has deleted the message by the time it comes back.
const heldReturns = new Map<string, ReturnedSentMessageDrafts[]>();
const heldReturnListeners = new Set<() => void>();

export function holdReturnedSentMessage(threadKey: string, returned: ReturnedSentMessageDrafts) {
  heldReturns.set(threadKey, [...(heldReturns.get(threadKey) ?? []), returned]);
  for (const listener of heldReturnListeners) listener();
}

/** Hands over, and forgets, what waits for this thread's composer. */
export function takeReturnedSentMessages(
  threadKey: string,
): ReadonlyArray<ReturnedSentMessageDrafts> {
  const held = heldReturns.get(threadKey) ?? [];
  heldReturns.delete(threadKey);
  return held;
}

export function subscribeReturnedSentMessages(listener: () => void): () => void {
  heldReturnListeners.add(listener);
  return () => {
    heldReturnListeners.delete(listener);
  };
}

export type EditFromHereResult =
  /** Nothing goes back: cancelled, refused (with what to tell the user), or not rewound. */
  | { readonly kind: "stopped"; readonly error: string | null }
  /**
   * The message waits for the composer (`takeReturnedSentMessages`): the node
   * rewound the thread (`notice` is worth showing), or Ryco could not confirm
   * it either way (`error` says so).
   */
  | {
      readonly kind: "returned";
      readonly notice: CheckpointRevertNotice | null;
      readonly error: string | null;
    };

/**
 * The whole flow, outside the screen (a component with `try` cannot be
 * compiled): refuse early, ask, load the attachments, send the revert, wait for
 * the node's verdict, and hold the message for the composer.
 */
export async function runEditFromHere(input: {
  readonly api: EnvironmentApi | null;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadKey: string;
  readonly message: ChatMessage;
  readonly turnCount: number;
  readonly environmentUnavailable: boolean;
  readonly turnInProgress: boolean;
  readonly providerRefusal: string | null;
  readonly keepFilesAvailable: boolean;
  readonly keptChangesTurnCount: number | null;
  readonly composerAttachments: ReadonlyArray<{ readonly sizeBytes: number }>;
  readonly fileUploadsSupported: boolean;
  /** The thread as this app holds it, and its changes. */
  readonly readThread: () => CheckpointRevertThreadView | undefined;
  readonly subscribe: (listener: () => void) => () => void;
}): Promise<EditFromHereResult> {
  const { api, threadId, message } = input;
  const result = await runCheckpointRevert<ReturnedSentMessageDrafts>({
    environmentId: input.environmentId,
    dispatchCommand: api ? (command) => api.orchestration.dispatchCommand(command) : null,
    threadId,
    turnCount: input.turnCount,
    environmentUnavailable: input.environmentUnavailable,
    environmentUnavailableLabel: null,
    turnInProgress: input.turnInProgress,
    providerRefusal: input.providerRefusal,
    choose: () =>
      chooseCheckpointRevertMode({
        keepFilesAvailable: input.keepFilesAvailable,
        keptChangesTurnCount: input.keptChangesTurnCount,
      }),
    prepare: () =>
      loadSentMessageDrafts({
        message,
        composerAttachments: input.composerAttachments,
        fileUploadsSupported: input.fileUploadsSupported,
        readBytes: (attachment) =>
          readAttachmentBytesFromTransport({
            reference: { threadId, messageId: message.id, attachmentId: attachment.id },
            sizeBytes: attachment.sizeBytes,
            currentTransport: () => api?.attachments,
          }),
      }),
    newCommandId,
    readThread: input.readThread,
    subscribe: input.subscribe,
  });
  switch (result.kind) {
    case "refused":
      return { kind: "stopped", error: revertCheckpointGuardFailureMessage(result.reason) };
    case "not-reverted":
      return { kind: "stopped", error: result.error };
    case "reverted":
      holdReturnedSentMessage(input.threadKey, result.prepared);
      return { kind: "returned", notice: result.notice, error: null };
    case "unconfirmed":
      holdReturnedSentMessage(input.threadKey, result.prepared);
      return { kind: "returned", notice: null, error: result.error };
  }
}
