import { type MutableRefObject, useCallback, useMemo, useState } from "react";
import type { ApprovalRequestId, ApprovalResponseIdentity } from "@ryco/contracts";
import type { PendingUserInput } from "../../session-logic";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
  type PendingUserInputProgress,
} from "../../pendingUserInput";
import type { ChatComposerHandle } from "./ChatComposer";

const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};

export interface UseChatPendingUserInputInput {
  pendingUserInputs: ReadonlyArray<PendingUserInput>;
  respondingUserInputRequestIds: ReadonlyArray<ApprovalRequestId>;
  readComposer: () => ChatComposerHandle | null;
  promptRef: MutableRefObject<string>;
  onRespondToUserInput: (
    requestId: ApprovalRequestId,
    answers: Record<string, string | string[]>,
    userInputIdentity?: ApprovalResponseIdentity,
  ) => void | Promise<void>;
}

export interface UseChatPendingUserInputResult {
  activePendingUserInput: PendingUserInput | null;
  activePendingDraftAnswers: Record<string, PendingUserInputDraftAnswer>;
  activePendingQuestionIndex: number;
  activePendingProgress: PendingUserInputProgress | null;
  activePendingResolvedAnswers: Record<string, string | string[]> | null;
  activePendingIsResponding: boolean;
  onSelectActivePendingUserInputOption: (questionId: string, optionLabel: string) => void;
  onChangeActivePendingUserInputCustomAnswer: (
    questionId: string,
    value: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
  ) => void;
  onAdvanceActivePendingUserInput: () => void;
  onPreviousActivePendingUserInputQuestion: () => void;
}

/**
 * Owns the per-request draft answers and question navigation state for the
 * active pending user-input request, plus the handlers that mutate them.
 */
export function useChatPendingUserInput(
  input: UseChatPendingUserInputInput,
): UseChatPendingUserInputResult {
  const { pendingUserInputs, respondingUserInputRequestIds, readComposer, promptRef } = input;
  const onRespondToUserInput = input.onRespondToUserInput;

  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({});

  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const activePendingDraftAnswers = useMemo(
    () =>
      activePendingUserInput
        ? (pendingUserInputAnswersByRequestId[
            activePendingUserInput.userInputIdentity?.requestEventId ??
              activePendingUserInput.requestId
          ] ?? EMPTY_PENDING_USER_INPUT_ANSWERS)
        : EMPTY_PENDING_USER_INPUT_ANSWERS,
    [activePendingUserInput, pendingUserInputAnswersByRequestId],
  );
  const activePendingQuestionIndex = activePendingUserInput
    ? (pendingUserInputQuestionIndexByRequestId[
        activePendingUserInput.userInputIdentity?.requestEventId ?? activePendingUserInput.requestId
      ] ?? 0)
    : 0;
  const activePendingProgress = useMemo(
    () =>
      activePendingUserInput
        ? derivePendingUserInputProgress(
            activePendingUserInput.questions,
            activePendingDraftAnswers,
            activePendingQuestionIndex,
          )
        : null,
    [activePendingDraftAnswers, activePendingQuestionIndex, activePendingUserInput],
  );
  const activePendingResolvedAnswers = useMemo(
    () =>
      activePendingUserInput
        ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
        : null,
    [activePendingDraftAnswers, activePendingUserInput],
  );
  const activePendingIsResponding = activePendingUserInput
    ? respondingUserInputRequestIds.includes(activePendingUserInput.requestId) ||
      activePendingUserInput.responseState === "submitting" ||
      activePendingUserInput.responseState === "uncertain"
    : false;

  const setActivePendingUserInputQuestionIndex = useCallback(
    (nextQuestionIndex: number) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.userInputIdentity?.requestEventId ??
        activePendingUserInput.requestId]: nextQuestionIndex,
      }));
    },
    [activePendingUserInput],
  );

  const onSelectActivePendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputAnswersByRequestId((existing) => {
        const question =
          (activePendingProgress?.activeQuestion?.id === questionId
            ? activePendingProgress.activeQuestion
            : undefined) ??
          activePendingUserInput.questions.find((entry) => entry.id === questionId);
        if (!question) {
          return existing;
        }

        return {
          ...existing,
          [activePendingUserInput.userInputIdentity?.requestEventId ??
          activePendingUserInput.requestId]: {
            ...existing[
              activePendingUserInput.userInputIdentity?.requestEventId ??
                activePendingUserInput.requestId
            ],
            [questionId]: togglePendingUserInputOptionSelection(
              question,
              existing[
                activePendingUserInput.userInputIdentity?.requestEventId ??
                  activePendingUserInput.requestId
              ]?.[questionId],
              optionLabel,
            ),
          },
        };
      });
      promptRef.current = "";
      readComposer()?.resetCursorState({ cursor: 0 });
    },
    [activePendingProgress?.activeQuestion, activePendingUserInput, promptRef, readComposer],
  );

  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (
      questionId: string,
      value: string,
      nextCursor: number,
      expandedCursor: number,
      _cursorAdjacentToMention: boolean,
    ) => {
      if (!activePendingUserInput) {
        return;
      }
      promptRef.current = value;
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.userInputIdentity?.requestEventId ??
        activePendingUserInput.requestId]: {
          ...existing[
            activePendingUserInput.userInputIdentity?.requestEventId ??
              activePendingUserInput.requestId
          ],
          [questionId]: setPendingUserInputCustomAnswer(
            existing[
              activePendingUserInput.userInputIdentity?.requestEventId ??
                activePendingUserInput.requestId
            ]?.[questionId],
            value,
          ),
        },
      }));
      const snapshot = readComposer()?.readSnapshot();
      if (
        snapshot?.value !== value ||
        snapshot.cursor !== nextCursor ||
        snapshot.expandedCursor !== expandedCursor
      ) {
        readComposer()?.focusAt(nextCursor);
      }
    },
    [activePendingUserInput, promptRef, readComposer],
  );

  const onAdvanceActivePendingUserInput = useCallback(() => {
    if (!activePendingUserInput || !activePendingProgress) {
      return;
    }
    if (activePendingProgress.isLastQuestion) {
      if (activePendingResolvedAnswers && !activePendingIsResponding) {
        void onRespondToUserInput(
          activePendingUserInput.requestId,
          activePendingResolvedAnswers,
          activePendingUserInput.userInputIdentity,
        );
      }
      return;
    }
    setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
  }, [
    activePendingProgress,
    activePendingIsResponding,
    activePendingResolvedAnswers,
    activePendingUserInput,
    onRespondToUserInput,
    setActivePendingUserInputQuestionIndex,
  ]);

  const onPreviousActivePendingUserInputQuestion = useCallback(() => {
    if (!activePendingProgress) {
      return;
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  }, [activePendingProgress, setActivePendingUserInputQuestionIndex]);

  return {
    activePendingUserInput,
    activePendingDraftAnswers,
    activePendingQuestionIndex,
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingIsResponding,
    onSelectActivePendingUserInputOption,
    onChangeActivePendingUserInputCustomAnswer,
    onAdvanceActivePendingUserInput,
    onPreviousActivePendingUserInputQuestion,
  };
}
