import { useState } from "react";
import { Pressable, View } from "react-native";

import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import type { PendingUserInput } from "@ryco/client-runtime/state/session";
import {
  buildPendingUserInputAnswers,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "@ryco/client-runtime/state/user-input";

import { AppText as Text } from "../../components/AppText";
import { ensureEnvironmentApi } from "../../connection/environmentApi";
import { respondToThreadUserInput } from "./sessionActions";

// §3-16: draft answers are UI-local state; the answer assembly + validation come
// from the runtime user-input helpers (single source of truth).
export function PendingUserInputCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly userInput: PendingUserInput;
  /** Cached/degraded threads render the prompt but cannot answer it. */
  readonly disabled?: boolean;
}) {
  const [drafts, setDrafts] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (questionId: string, optionLabel: string) => {
    setDrafts((current) => {
      const question = props.userInput.questions.find((q) => q.id === questionId);
      if (!question) return current;
      return {
        ...current,
        [questionId]: togglePendingUserInputOptionSelection(
          question,
          current[questionId],
          optionLabel,
        ),
      };
    });
  };

  const isSelected = (questionId: string, optionLabel: string): boolean =>
    Boolean(drafts[questionId]?.selectedOptionLabels?.includes(optionLabel));

  const answers = buildPendingUserInputAnswers(props.userInput.questions, drafts);
  const canSubmit =
    answers !== null &&
    !submitting &&
    props.disabled !== true &&
    props.userInput.responseState !== "submitting" &&
    props.userInput.responseState !== "uncertain";

  const submit = async () => {
    if (!answers || !canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await respondToThreadUserInput({
        api: ensureEnvironmentApi(props.environmentId),
        threadId: props.threadId,
        requestId: props.userInput.requestId,
        answers,
        userInputIdentity: props.userInput.userInputIdentity,
      });
    } catch {
      // `ensureEnvironmentApi` throws synchronously without a connection, and
      // the RPC itself can reject; without this catch the `void submit()`
      // press handler turned both into a silent unhandled rejection. Bounded
      // copy: the raw message is an internal string the user cannot act on.
      setError("The answers could not be delivered. Reconnect and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View className="mx-4 my-2 rounded-2xl border border-accent-border bg-accent-bg p-4">
      <Text className="text-xs font-ryco-bold uppercase tracking-wide text-accent-strong">
        Input needed
      </Text>
      {props.userInput.questions.map((question) => (
        <View key={question.id} className="mt-3">
          <Text className="font-sans text-base text-foreground">{question.question}</Text>
          <View className="mt-2 gap-2">
            {question.options.map((option) => (
              <Pressable
                key={option.label}
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
      {props.userInput.responseState === "uncertain" ? (
        <Text accessibilityRole="text" className="mt-2 font-sans text-sm text-foreground-muted">
          Answer delivery is unconfirmed. Await provider confirmation or restart the turn; resending
          could duplicate it.
        </Text>
      ) : null}
      {error ? <Text className="mt-2 font-sans text-sm text-danger">{error}</Text> : null}
      <Pressable
        disabled={!canSubmit}
        onPress={() => void submit()}
        className="mt-4 h-11 items-center justify-center rounded-full bg-primary px-4 active:opacity-70 disabled:opacity-40"
      >
        <Text className="text-sm font-ryco-bold text-primary-foreground">Submit</Text>
      </Pressable>
    </View>
  );
}
