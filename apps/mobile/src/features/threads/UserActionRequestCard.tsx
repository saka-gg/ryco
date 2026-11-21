import { useState } from "react";
import { Pressable, View } from "react-native";

import type { EnvironmentId, ThreadId, UserActionOutcome } from "@ryco/contracts";
import {
  USER_ACTION_DECLINE_LABEL,
  USER_ACTION_DONE_LABEL,
  userActionContinueElsewhereHint,
  userActionOutcomeLine,
  userActionRequestLabel,
  type UserActionRequestView,
} from "@ryco/client-runtime/userActionRequests";

import { AppText as Text } from "../../components/AppText";
import { ensureEnvironmentApi } from "../../connection/environmentApi";
import { sendUserActionRequestAnswer } from "./userActionRequestCardModel";

/**
 * One card for an agent's user action request: a browser tab or terminal on the node that waits
 * for the user (a sign-in, a code, a captcha, a consent). The phone cannot show that surface, so
 * the card says where to continue and offers Done and Won't do; it never shows a Show button.
 */
export function UserActionRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly request: UserActionRequestView;
  /** Why this device cannot answer, or null when it can. */
  readonly disabledReason: string | null;
}) {
  const [sending, setSending] = useState<"done" | "declined" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<UserActionOutcome | null>(null);
  const locked = props.disabledReason !== null || sending !== null || outcome !== null;
  const label = userActionRequestLabel(props.request);

  const submit = async (answer: "done" | "declined") => {
    if (locked) return;
    setError(null);
    setSending(answer);
    // Never throws: every outcome comes back as a result.
    const sent = await sendUserActionRequestAnswer({
      api: () => ensureEnvironmentApi(props.environmentId),
      threadId: props.threadId,
      requestId: props.request.requestId,
      answer,
    });
    setSending(null);
    if (sent.kind === "failed") setError(sent.error);
    else setOutcome(sent.outcome);
  };

  return (
    <View accessibilityLabel={label} className="mx-4 my-1.5 rounded-2xl bg-accent-bg p-4">
      <Text className="text-xs font-ryco-bold uppercase tracking-wide text-accent-strong">
        {label}
      </Text>
      <Text className="mt-2 font-sans text-base text-foreground">{props.request.message}</Text>
      {outcome !== null ? (
        <Text accessibilityRole="text" className="mt-3 font-sans text-sm text-foreground">
          {userActionOutcomeLine(outcome)}
        </Text>
      ) : (
        <>
          <Text className="mt-1 font-sans text-sm text-foreground-muted">
            {userActionContinueElsewhereHint(props.request.surface)}
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={locked}
            onPress={() => void submit("done")}
            className="mt-4 h-11 items-center justify-center rounded-full bg-primary px-4 active:opacity-70 disabled:opacity-40"
          >
            <Text className="text-sm font-ryco-bold text-primary-foreground">
              {sending === "done" ? "Finishing…" : USER_ACTION_DONE_LABEL}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={locked}
            onPress={() => void submit("declined")}
            className="mt-3 min-h-11 items-center justify-center disabled:opacity-40"
          >
            <Text>{sending === "declined" ? "Declining…" : USER_ACTION_DECLINE_LABEL}</Text>
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
