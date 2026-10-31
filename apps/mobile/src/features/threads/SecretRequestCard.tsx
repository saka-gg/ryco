import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";

import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import {
  SECRET_REQUEST_FIELD_PLACEHOLDER,
  secretRequestOutcomeText,
  secretRequestPrivacyNote,
  type SecretRequestDraftAnswer,
  type SecretRequestView,
} from "@ryco/client-runtime/secretRequests";

import { AppText as Text } from "../../components/AppText";
import { ensureEnvironmentApi } from "../../connection/environmentApi";
import { runWhileBusy } from "../../lib/runWhileBusy";
import { sendSecretRequestAnswer } from "./secretRequestCardModel";

/**
 * One private card for an agent's secret request. The typed value stays in this card's state,
 * is sent only in `secrets.answerRequest`, and is cleared once the node took it. The field is
 * secure text with autofill and autocorrect off, so the keyboard neither learns nor offers it.
 */
export function SecretRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly request: SecretRequestView;
  /** Why this device cannot answer, or null when it can. */
  readonly disabledReason: string | null;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<"provided" | "declined" | null>(null);
  const locked = props.disabledReason !== null || busy || outcome !== null;

  const submit = async (answer: SecretRequestDraftAnswer) => {
    if (locked) return;
    setError(null);
    const sent = await runWhileBusy(setBusy, () =>
      sendSecretRequestAnswer({
        api: () => ensureEnvironmentApi(props.environmentId),
        threadId: props.threadId,
        requestId: props.request.requestId,
        answer,
      }),
    );
    if (sent.kind === "failed") setError(sent.error);
    if (sent.kind !== "answered") return;
    setValue("");
    setOutcome(sent.outcome);
  };

  return (
    <View className="mx-4 my-2 rounded-2xl border border-accent-border bg-accent-bg p-4">
      <Text className="text-xs font-ryco-bold uppercase tracking-wide text-accent-strong">
        Secret requested
      </Text>
      <Text className="mt-2 font-sans text-base text-foreground">
        The agent asks for {props.request.key}
      </Text>
      <Text className="mt-1 font-sans text-sm text-foreground-muted">{props.request.purpose}</Text>
      <Text className="mt-1 font-sans text-xs text-foreground-muted">
        Saved to {props.request.file} in this thread&apos;s checkout.
      </Text>
      {outcome !== null ? (
        <Text accessibilityRole="text" className="mt-3 font-sans text-sm text-foreground">
          {secretRequestOutcomeText(props.request, outcome)}
        </Text>
      ) : (
        <>
          <TextInput
            accessibilityLabel={`Value for ${props.request.key}`}
            editable={!locked}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            importantForAutofill="no"
            textContentType="none"
            spellCheck={false}
            placeholder={SECRET_REQUEST_FIELD_PLACEHOLDER}
            value={value}
            onChangeText={setValue}
            className="mt-3 rounded-xl border border-border px-3 py-2 font-mono text-foreground"
          />
          <Text className="mt-2 text-xs text-foreground-muted">
            {secretRequestPrivacyNote(props.request.file)}
          </Text>
          <Pressable
            disabled={locked || value.trim().length === 0}
            onPress={() => void submit({ type: "provide", value })}
            className="mt-4 h-11 items-center justify-center rounded-full bg-primary px-4 active:opacity-70 disabled:opacity-40"
          >
            <Text className="text-sm font-ryco-bold text-primary-foreground">Save</Text>
          </Pressable>
          <Pressable
            disabled={locked}
            onPress={() => void submit({ type: "decline" })}
            className="mt-3 min-h-11 items-center justify-center"
          >
            <Text>Decline</Text>
          </Pressable>
        </>
      )}
      {props.disabledReason !== null && outcome === null ? (
        <Text className="mt-2 font-sans text-xs text-foreground-muted">{props.disabledReason}</Text>
      ) : null}
      {error ? <Text className="mt-2 font-sans text-sm text-danger">{error}</Text> : null}
    </View>
  );
}
