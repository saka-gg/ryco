import { useState, useSyncExternalStore } from "react";
import { Pressable, TextInput, View } from "react-native";

import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import type { PendingUserInput } from "@ryco/client-runtime/state/session";
import {
  buildPendingUserInputAnswers,
  clearQuestionDraft,
  questionDraftKey,
  readQuestionDraft,
  setPendingUserInputCustomAnswer,
  setQuestionDraftAnswer,
  subscribeQuestionDrafts,
  togglePendingUserInputOptionSelection,
  type OptionalAnswerRoute,
} from "@ryco/client-runtime/state/user-input";

import { AppText as Text } from "../../components/AppText";
import { ensureEnvironmentApi } from "../../connection/environmentApi";
import { runWhileBusy } from "../../lib/runWhileBusy";
import {
  deliverPendingUserInputAnswer,
  pendingUserInputCardView,
} from "./pendingUserInputCardModel";
import { respondToThreadUserInput } from "./sessionActions";

// §3-16: drafts live in the runtime's question draft store (shared with web), so they outlive
// the card; answer assembly and validation come from the runtime user-input helpers.
export function PendingUserInputCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly userInput: PendingUserInput;
  /** How an optional question's answer reaches the agent now (`resolveOptionalAnswerRoute`). */
  readonly route?: OptionalAnswerRoute;
  /** Sends an optional question's answer as a new message once its turn ended. */
  readonly onSendAsMessage?: (
    userInput: PendingUserInput,
    answers: Record<string, string | string[]>,
  ) => Promise<void>;
  /** Cached/degraded threads render the prompt but cannot answer it. */
  readonly disabled?: boolean;
}) {
  const draftKey = questionDraftKey({
    environmentId: props.environmentId,
    threadId: props.threadId,
    requestId: props.userInput.requestId,
    userInputIdentity: props.userInput.userInputIdentity,
  });
  const readDraft = () => readQuestionDraft(draftKey);
  const drafts = useSyncExternalStore(subscribeQuestionDrafts, readDraft, readDraft).answers;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const route = props.route ?? "steer";

  const toggle = (questionId: string, optionLabel: string) => {
    const question = props.userInput.questions.find((q) => q.id === questionId);
    if (!question) return;
    setQuestionDraftAnswer(
      draftKey,
      questionId,
      togglePendingUserInputOptionSelection(
        question,
        readQuestionDraft(draftKey).answers[questionId],
        optionLabel,
      ),
    );
  };

  const isSelected = (questionId: string, optionLabel: string): boolean =>
    Boolean(drafts[questionId]?.selectedOptionLabels?.includes(optionLabel));

  const answers = buildPendingUserInputAnswers(props.userInput.questions, drafts);
  const view = pendingUserInputCardView({
    userInput: props.userInput,
    route,
    answers,
    disabled: props.disabled === true,
    submitting,
  });

  const respond = (submittedAnswers: Record<string, string | string[]>) =>
    respondToThreadUserInput({
      api: ensureEnvironmentApi(props.environmentId),
      threadId: props.threadId,
      requestId: props.userInput.requestId,
      answers: submittedAnswers,
      userInputIdentity: props.userInput.userInputIdentity,
    });

  const submit = async (dismiss = false) => {
    if (dismiss ? !view.canDismiss : !answers || !view.canSubmit) return;
    const onSendAsMessage = props.onSendAsMessage;
    // Built before the try: the compiler keeps conditionals out of try/catch.
    const deliver = dismiss
      ? () => respond({})
      : () =>
          deliverPendingUserInputAnswer({
            userInput: props.userInput,
            route,
            answers: answers!,
            respond,
            sendAsMessage: onSendAsMessage && ((value) => onSendAsMessage(props.userInput, value)),
          });
    setError(null);
    await runWhileBusy(setSubmitting, async () => {
      try {
        await deliver();
        clearQuestionDraft(draftKey);
      } catch {
        // `ensureEnvironmentApi` throws synchronously without a connection, and
        // the RPC itself can reject; without this catch the `void submit()`
        // press handler turned both into a silent unhandled rejection. Bounded
        // copy: the raw message is an internal string the user cannot act on.
        setError("The answers could not be delivered. Reconnect and try again.");
      }
    });
  };

  return (
    <View className="mx-4 my-2 rounded-2xl border border-accent-border bg-accent-bg p-4">
      <Text className="text-xs font-ryco-bold uppercase tracking-wide text-accent-strong">
        {view.title}
      </Text>
      {props.userInput.questions.map((question) => (
        <View key={question.id} className="mt-3">
          <Text className="font-sans text-base text-foreground">{question.question}</Text>
          {props.userInput.nonBlocking ? (
            <TextInput
              accessibilityLabel={`Custom answer: ${question.question}`}
              editable={view.editable}
              placeholder="Write an answer"
              value={drafts[question.id]?.customAnswer ?? ""}
              onChangeText={(text) =>
                setQuestionDraftAnswer(
                  draftKey,
                  question.id,
                  setPendingUserInputCustomAnswer(
                    readQuestionDraft(draftKey).answers[question.id],
                    text,
                  ),
                )
              }
              className="mt-2 rounded-xl border border-border px-3 py-2 text-foreground"
            />
          ) : null}
          <View className="mt-2 gap-2">
            {question.options.map((option) => (
              <Pressable
                key={option.label}
                disabled={!view.editable}
                onPress={() => toggle(question.id, option.label)}
                className={`min-h-11 justify-center rounded-xl border px-3 py-2.5 active:opacity-70 ${
                  isSelected(question.id, option.label)
                    ? "border-primary bg-primary/10"
                    : "border-border bg-card"
                }`}
              >
                <Text className="font-sans text-sm text-foreground">{option.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ))}
      {view.hint ? <Text className="mt-2 text-xs text-foreground-muted">{view.hint}</Text> : null}
      {props.userInput.responseState === "uncertain" ? (
        <Text accessibilityRole="text" className="mt-2 font-sans text-sm text-foreground-muted">
          Answer delivery is unconfirmed. Await provider confirmation or restart the turn; resending
          could duplicate it.
        </Text>
      ) : null}
      {error ? <Text className="mt-2 font-sans text-sm text-danger">{error}</Text> : null}
      <Pressable
        disabled={!view.canSubmit}
        onPress={() => void submit()}
        className="mt-4 h-11 items-center justify-center rounded-full bg-primary px-4 active:opacity-70 disabled:opacity-40"
      >
        <Text className="text-sm font-ryco-bold text-primary-foreground">Submit</Text>
      </Pressable>
      {props.userInput.nonBlocking ? (
        <Pressable
          disabled={!view.canDismiss}
          onPress={() => void submit(true)}
          className="mt-3 min-h-11 items-center justify-center"
        >
          <Text>Dismiss</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
