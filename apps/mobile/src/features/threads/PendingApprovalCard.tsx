import { useState } from "react";
import { Pressable, View } from "react-native";

import type { EnvironmentId, ProviderApprovalDecision, ThreadId } from "@ryco/contracts";
import {
  APPROVAL_REASON_LABEL,
  pendingApprovalReason,
  type PendingApproval,
} from "@ryco/client-runtime/state/session";

import { AppText as Text } from "../../components/AppText";
import { answerThreadApproval } from "./threadRequestAnswers";

/** The answer as the card shows it the moment it is chosen. */
const DECISION_LABEL: Record<ProviderApprovalDecision, string> = {
  accept: "Allowed",
  acceptForSession: "Allowed for this session",
  decline: "Denied",
  cancel: "Cancelled",
};

const REQUEST_KIND_LABEL: Record<PendingApproval["requestKind"], string> = {
  command: "Run command",
  "file-read": "Read file",
  "file-change": "Change file",
};

export function PendingApprovalCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly approval: PendingApproval;
  /** Cached/degraded threads render the prompt but cannot answer it. */
  readonly disabled?: boolean;
}) {
  // The chosen answer shows at once and stays until the node settles the request (the card
  // leaves); a failed delivery takes it back and says so.
  const [chosen, setChosen] = useState<ProviderApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const reason = pendingApprovalReason(props.approval);

  const respond = async (decision: ProviderApprovalDecision) => {
    setChosen(decision);
    setError(null);
    try {
      await answerThreadApproval({
        environmentId: props.environmentId,
        threadId: props.threadId,
        approval: props.approval,
        decision,
      });
    } catch {
      // No connection, or the RPC rejected; without this catch the `void respond(...)`
      // press handler turned both into a silent unhandled rejection. Bounded
      // copy: the raw message is an internal string the user cannot act on.
      setChosen(null);
      setError("The decision could not be delivered. Reconnect and try again.");
    }
  };
  const answerLocked =
    props.disabled === true ||
    (props.approval.responseState !== undefined && props.approval.responseState !== "retryable");

  return (
    <View className="mx-4 my-1.5 rounded-2xl bg-warning-bg p-4">
      <Text className="text-xs font-ryco-bold uppercase tracking-wide text-warning">
        Approval needed
      </Text>
      <Text className="mt-1 font-sans text-base text-foreground">
        {REQUEST_KIND_LABEL[props.approval.requestKind]}
      </Text>
      {props.approval.detail ? (
        <Text className="mt-1 font-mono text-sm text-foreground-muted" numberOfLines={4}>
          {props.approval.detail}
        </Text>
      ) : null}
      {reason ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: reasonOpen }}
          onPress={() => setReasonOpen((open) => !open)}
          className="mt-2 active:opacity-70"
        >
          <Text className="text-xs font-ryco-medium text-foreground-muted underline">
            {APPROVAL_REASON_LABEL}
          </Text>
          {reasonOpen ? (
            <Text className="mt-1 font-sans text-sm text-foreground-muted">{reason}</Text>
          ) : null}
        </Pressable>
      ) : null}
      {chosen === null &&
      (props.approval.responseState === "submitting" ||
        props.approval.responseState === "uncertain") ? (
        <Text className="mt-2 text-sm text-foreground-muted">
          Decision submitted. Waiting for provider settlement.
        </Text>
      ) : null}
      {error ? <Text className="mt-2 font-sans text-sm text-danger">{error}</Text> : null}
      {chosen !== null ? (
        <View
          accessibilityLiveRegion="polite"
          className="mt-3 h-11 flex-row items-center justify-center rounded-full border border-border px-4"
        >
          <Text className="text-sm font-ryco-bold text-foreground">{DECISION_LABEL[chosen]}</Text>
        </View>
      ) : (
        <View className="mt-3 flex-row flex-wrap gap-2">
          <Pressable
            disabled={answerLocked}
            onPress={() => void respond("accept")}
            className="h-11 min-w-28 flex-1 items-center justify-center rounded-full bg-primary px-4 active:opacity-70 disabled:opacity-50"
          >
            <Text className="text-sm font-ryco-bold text-primary-foreground">Allow</Text>
          </Pressable>
          <Pressable
            disabled={answerLocked}
            onPress={() => void respond("decline")}
            className="h-11 min-w-28 flex-1 items-center justify-center rounded-full border border-border px-4 active:opacity-70 disabled:opacity-50"
          >
            <Text className="text-sm font-ryco-bold text-foreground">Deny</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
