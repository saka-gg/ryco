import { useState } from "react";
import { Linking, Pressable, View } from "react-native";

import type { EnvironmentId, ThreadId, UserActionOutcome } from "@ryco/contracts";
import {
  USER_ACTION_DECLINE_LABEL,
  USER_ACTION_DONE_LABEL,
  USER_ACTION_SHOW_LABEL,
  userActionContinueElsewhereHint,
  userActionDoneHint,
  userActionOutcomeLine,
  userActionRequestLabel,
  type UserActionRequestView,
} from "@ryco/client-runtime/userActionRequests";

import {
  USER_ACTION_HINT_INTERNATIONAL_NOTE,
  type UserActionHint,
} from "@ryco/shared/userActionHints";

import { AppText as Text } from "../../components/AppText";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { ensureEnvironmentApi } from "../../connection/environmentApi";
import { sendUserActionRequestAnswer } from "./userActionRequestCardModel";

/**
 * One card for an agent's user action request: a browser tab or terminal on the node that waits
 * for the user (a sign-in, a code, a captcha, a consent). A terminal opens on the phone (Show);
 * a browser tab cannot, so the card says where to continue. Sign-in links and codes the terminal
 * printed show with Open and Copy.
 */
export function UserActionRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly request: UserActionRequestView;
  /** Why this device cannot answer, or null when it can. */
  readonly disabledReason: string | null;
  readonly hint?: UserActionHint | undefined;
  /** Opens the request's terminal on the phone; absent for surfaces the phone cannot show. */
  readonly onShow?: (() => void) | undefined;
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
            {props.onShow === undefined
              ? userActionContinueElsewhereHint(props.request.surface)
              : userActionDoneHint(props.request.surface)}
          </Text>
          {props.hint === undefined ? null : <UserActionHintRows hint={props.hint} />}
          {props.onShow === undefined ? null : (
            <Pressable
              accessibilityRole="button"
              onPress={props.onShow}
              className="mt-4 h-11 items-center justify-center rounded-full border border-border px-4 active:opacity-70"
            >
              <Text className="text-sm font-ryco-bold text-foreground">
                {USER_ACTION_SHOW_LABEL}
              </Text>
            </Pressable>
          )}
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

/** A terminal's sign-in links and codes: Open in the browser, Copy the code. */
function UserActionHintRows(props: { readonly hint: UserActionHint }) {
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <View className="mt-3 gap-2">
      {props.hint.codes.map((code) => (
        <View key={`code-${code}`} className="flex-row items-center gap-3">
          <Text className="font-mono text-base tracking-widest text-foreground">{code}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Copy code ${code}`}
            onPress={() => {
              copyTextWithHaptic(code, { target: "sign-in code" });
              setCopied(code);
            }}
            className="min-h-11 justify-center"
          >
            <Text className="text-sm text-accent-strong">
              {copied === code ? "Copied" : "Copy"}
            </Text>
          </Pressable>
        </View>
      ))}
      {props.hint.links.map((link) => (
        // The real host first (as the node parsed it): the printed link can dress another host
        // up. Nothing here parses the link: React Native's URL knows no punycode.
        <Pressable
          key={`link-${link.url}`}
          accessibilityRole="link"
          accessibilityLabel={`Open ${link.host}`}
          onPress={() => void Linking.openURL(link.url).catch(() => undefined)}
          className="min-h-11 justify-center"
        >
          <Text className="font-sans text-sm font-ryco-bold text-accent-strong">{`Open ${link.host}`}</Text>
          {link.international ? (
            <Text className="font-sans text-xs text-warning">
              {USER_ACTION_HINT_INTERNATIONAL_NOTE}
            </Text>
          ) : null}
          <Text numberOfLines={1} className="font-mono text-xs text-foreground-muted">
            {link.url}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
