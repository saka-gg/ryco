/**
 * What the user drafted for an agent's question, per question: the chosen options and written
 * answers, and the files attached to the answer. Kept here rather than in a card's own state,
 * so a draft outlives the card: switching threads, collapsing it, or a reconnect that remounts
 * it keeps what was typed. Web and native share it. Memory only, like the bytes of the files
 * (the platform's upload queue holds those, under the same attachment ids).
 */
import type { ApprovalResponseIdentity, EnvironmentId, ThreadId } from "@ryco/contracts";
import { create } from "zustand";

import type { PendingUserInputDraftAnswer } from "./pendingUserInput.ts";

/** A file attached to an answer; its upload state lives in the platform's upload queue. */
export interface QuestionDraftAttachment {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

export interface QuestionDraft {
  readonly answers: Readonly<Record<string, PendingUserInputDraftAnswer>>;
  readonly attachments: readonly QuestionDraftAttachment[];
}

export const EMPTY_QUESTION_DRAFT: QuestionDraft = Object.freeze({
  answers: Object.freeze({}),
  attachments: Object.freeze([]) as readonly QuestionDraftAttachment[],
});

/**
 * One question generation: a provider may reuse a request id for a later question, which then
 * starts from an empty draft.
 */
export function questionDraftKey(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly requestId: string;
  readonly userInputIdentity?: ApprovalResponseIdentity | undefined;
}): string {
  return JSON.stringify([
    input.environmentId,
    input.threadId,
    input.userInputIdentity?.requestEventId ?? input.requestId,
  ]);
}

interface QuestionDraftState {
  readonly drafts: Readonly<Record<string, QuestionDraft>>;
}

const useQuestionDraftStore = create<QuestionDraftState>(() => ({ drafts: {} }));

function update(key: string, change: (draft: QuestionDraft) => QuestionDraft): void {
  useQuestionDraftStore.setState((state) => ({
    drafts: { ...state.drafts, [key]: change(state.drafts[key] ?? EMPTY_QUESTION_DRAFT) },
  }));
}

export function readQuestionDraft(key: string): QuestionDraft {
  return useQuestionDraftStore.getState().drafts[key] ?? EMPTY_QUESTION_DRAFT;
}

export function subscribeQuestionDrafts(listener: () => void): () => void {
  return useQuestionDraftStore.subscribe(listener);
}

export function setQuestionDraftAnswer(
  key: string,
  questionId: string,
  answer: PendingUserInputDraftAnswer,
): void {
  update(key, (draft) => ({ ...draft, answers: { ...draft.answers, [questionId]: answer } }));
}

export function addQuestionDraftAttachments(
  key: string,
  attachments: readonly QuestionDraftAttachment[],
): void {
  if (attachments.length === 0) return;
  update(key, (draft) => ({ ...draft, attachments: [...draft.attachments, ...attachments] }));
}

export function removeQuestionDraftAttachment(key: string, attachmentId: string): void {
  update(key, (draft) => ({
    ...draft,
    attachments: draft.attachments.filter((attachment) => attachment.id !== attachmentId),
  }));
}

/** Forgets the draft (an answer went out); returns what it held, so uploads can be released. */
export function clearQuestionDraft(key: string): QuestionDraft {
  const draft = readQuestionDraft(key);
  if (useQuestionDraftStore.getState().drafts[key] === undefined) return draft;
  useQuestionDraftStore.setState((state) => {
    const { [key]: _removed, ...drafts } = state.drafts;
    return { drafts };
  });
  return draft;
}
