import { useRef, useState, useSyncExternalStore } from "react";
import type { ApprovalRequestId, ApprovalResponseIdentity } from "@ryco/contracts";
import type { PendingUserInput } from "@ryco/client-runtime/state/session";
import {
  buildSendTurnUploadTokenDispatchAttachment,
  deriveChatFileUploadSendBlock,
  type ChatFileUploadRecord,
  type SendTurnDispatchAttachment,
} from "@ryco/client-runtime/state/composer";
import {
  addQuestionDraftAttachments,
  buildPendingUserInputAnswers,
  clearQuestionDraft,
  optionalAnswerTakesAttachments,
  optionalQuestionCardCopy,
  readQuestionDraft,
  removeQuestionDraftAttachment,
  setPendingUserInputCustomAnswer,
  setQuestionDraftAnswer,
  subscribeQuestionDrafts,
  togglePendingUserInputOptionSelection,
  type OptionalAnswerRoute,
} from "@ryco/client-runtime/state/user-input";

/**
 * The upload queue an answer's files go through: the composer's own, so a file is uploaded,
 * limited and recovered exactly as one attached to a message.
 */
export interface OptionalQuestionUploads {
  readonly maxBytes: number;
  readonly subscribe: (listener: () => void) => () => void;
  readonly snapshot: () => ReadonlyMap<string, ChatFileUploadRecord>;
  readonly enqueue: (attachmentId: string, file: File) => void;
  readonly release: (attachmentId: string) => void;
  /** The upload's token while it is still usable; null once it must be attached again. */
  readonly usableToken: (attachmentId: string) => string | null;
}

const NO_RECORDS: ReadonlyMap<string, ChatFileUploadRecord> = new Map();
const noSubscription = () => () => {};
const noRecords = () => NO_RECORDS;

function formatMegabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

function uploadStatusLabel(record: ChatFileUploadRecord | undefined): string {
  switch (record?.status.kind) {
    case "uploaded":
      return "Ready";
    case "failed":
      return "Upload failed";
    case "needsReattach":
      return "Attach again";
    case undefined:
      return "Attach again";
    default:
      return "Uploading…";
  }
}

export function OptionalQuestionCard({
  input,
  draftKey,
  route,
  disabled,
  disabledReason = null,
  onRespond,
  onSendAsMessage,
  uploads = null,
}: {
  input: PendingUserInput;
  /** Where its draft is kept (`questionDraftKey`), so the draft outlives this card. */
  draftKey: string;
  /** How an answer reaches the agent now (`resolveOptionalAnswerRoute`). */
  route: OptionalAnswerRoute;
  disabled: boolean;
  /** Why answering is unavailable right now, shown while the card is disabled. */
  disabledReason?: string | null;
  /** Steers the question's running turn, or dismisses the question (an empty answer map). */
  onRespond: (
    requestId: ApprovalRequestId,
    answers: Record<string, unknown>,
    identity?: ApprovalResponseIdentity,
  ) => Promise<void>;
  /** Sends the answer as a new message once the question's turn ended; rejects when refused. */
  onSendAsMessage: (
    input: PendingUserInput,
    answers: Record<string, string | string[]>,
    attachments: readonly SendTurnDispatchAttachment[],
  ) => Promise<void>;
  /** Null when this connection cannot upload files. */
  uploads?: OptionalQuestionUploads | null;
}) {
  const readDraft = () => readQuestionDraft(draftKey);
  const draft = useSyncExternalStore(subscribeQuestionDrafts, readDraft, readDraft);
  const records = useSyncExternalStore(
    uploads?.subscribe ?? noSubscription,
    uploads?.snapshot ?? noRecords,
    uploads?.snapshot ?? noRecords,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = optionalQuestionCardCopy(route);
  const answers = buildPendingUserInputAnswers(input.questions, draft.answers);
  const takesAttachments = uploads !== null && optionalAnswerTakesAttachments(route);
  const uploadBlock =
    draft.attachments.length === 0
      ? null
      : !takesAttachments
        ? "Files can be sent once this turn ends."
        : deriveChatFileUploadSendBlock({
            attachmentIds: draft.attachments.map((attachment) => attachment.id),
            getRecord: (id) => records.get(id) ?? null,
            // Held back while preparing or failed. An expired token is caught when the answer
            // is sent (`usableToken`), which asks to attach the file again.
            nowMs: 0,
          }).blockReason;
  const locked =
    disabled ||
    sending ||
    input.responseState === "submitting" ||
    input.responseState === "uncertain";
  const run = async (work: () => Promise<void>) => {
    if (locked) return;
    setSending(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message.startsWith("Attach '")
          ? cause.message
          : "Could not submit the answer. Check the connection and question status.",
      );
    } finally {
      setSending(false);
    }
  };
  const releaseDraft = () => {
    for (const attachment of clearQuestionDraft(draftKey).attachments)
      uploads?.release(attachment.id);
  };
  const send = (value: Record<string, string | string[]>) =>
    run(async () => {
      if (route === "steer") {
        await onRespond(input.requestId, value, input.userInputIdentity);
        return;
      }
      const attachments = draft.attachments.map((attachment) => {
        const uploadToken = uploads?.usableToken(attachment.id) ?? null;
        if (uploadToken === null) throw new Error(`Attach '${attachment.name}' again to send it.`);
        return buildSendTurnUploadTokenDispatchAttachment({ ...attachment, uploadToken });
      });
      await onSendAsMessage(input, value, attachments);
      releaseDraft();
    });
  const dismiss = () =>
    run(async () => {
      await onRespond(input.requestId, {}, input.userInputIdentity);
      releaseDraft();
    });
  const attach = (files: readonly File[]) => {
    if (!uploads) return;
    const tooLarge = files.find((file) => file.size > uploads.maxBytes);
    if (tooLarge) {
      setError(`'${tooLarge.name}' is larger than the ${formatMegabytes(uploads.maxBytes)} limit.`);
      return;
    }
    setError(null);
    const attached = files.map((file) => ({
      id: crypto.randomUUID(),
      name: file.name || "file",
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      file,
    }));
    for (const attachment of attached) uploads.enqueue(attachment.id, attachment.file);
    addQuestionDraftAttachments(
      draftKey,
      attached.map(({ file: _file, ...attachment }) => attachment),
    );
  };
  return (
    <details className="mx-auto mb-2 w-full max-w-(--chat-composer-max-width) rounded-lg border border-border bg-background px-4 py-3">
      <summary className="cursor-pointer text-sm font-medium">{copy.title}</summary>
      <p className="mt-2 text-xs text-muted-foreground">{copy.hint}</p>
      {disabled && disabledReason ? (
        <p role="status" className="mt-1 text-xs text-muted-foreground">
          {disabledReason}
        </p>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (answers && route !== "wait" && uploadBlock === null) void send(answers);
        }}
      >
        <fieldset disabled={locked} className="space-y-3 py-3">
          {input.questions.map((question) => (
            <div key={question.id}>
              <label htmlFor={`${input.requestId}-${question.id}`} className="block text-sm">
                {question.question}
              </label>
              <div className="my-2 flex flex-wrap gap-2">
                {question.options.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    aria-pressed={
                      draft.answers[question.id]?.selectedOptionLabels?.includes(option.label) ??
                      false
                    }
                    className="rounded-md border border-border px-3 py-1 text-sm aria-pressed:bg-accent"
                    onClick={() =>
                      setQuestionDraftAnswer(
                        draftKey,
                        question.id,
                        togglePendingUserInputOptionSelection(
                          question,
                          readQuestionDraft(draftKey).answers[question.id],
                          option.label,
                        ),
                      )
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <input
                id={`${input.requestId}-${question.id}`}
                aria-label={`Custom answer: ${question.question}`}
                placeholder="Write an answer"
                value={draft.answers[question.id]?.customAnswer ?? ""}
                onChange={(event) =>
                  setQuestionDraftAnswer(
                    draftKey,
                    question.id,
                    setPendingUserInputCustomAnswer(
                      readQuestionDraft(draftKey).answers[question.id],
                      event.target.value,
                    ),
                  )
                }
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
          ))}
          {draft.attachments.length > 0 ? (
            <ul aria-label="Attached files" className="space-y-1">
              {draft.attachments.map((attachment) => {
                const record = records.get(attachment.id);
                return (
                  <li key={attachment.id} className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {uploadStatusLabel(record)}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${attachment.name}`}
                      className="text-xs text-muted-foreground"
                      onClick={() => {
                        removeQuestionDraftAttachment(draftKey, attachment.id);
                        uploads?.release(attachment.id);
                      }}
                    >
                      Remove
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {takesAttachments ? (
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              aria-label="Attach files to the answer"
              onChange={(event) => {
                attach(Array.from(event.target.files ?? []));
                event.target.value = "";
              }}
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={!answers || route === "wait" || uploadBlock !== null}
              className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
            >
              Send answer
            </button>
            {takesAttachments ? (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="text-sm text-muted-foreground"
              >
                Attach files
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void dismiss()}
              className="text-sm text-muted-foreground"
            >
              Dismiss
            </button>
          </div>
          {uploadBlock !== null ? (
            <p role="status" className="text-xs text-muted-foreground">
              {uploadBlock}
            </p>
          ) : null}
        </fieldset>
      </form>
      {input.responseState === "uncertain" ? (
        <p role="status" className="text-sm text-muted-foreground">
          Delivery is unconfirmed. This answer will not be resent automatically.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </details>
  );
}
