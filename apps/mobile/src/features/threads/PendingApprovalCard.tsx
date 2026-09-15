import { useState } from "react";
import { Pressable, View } from "react-native";

import type { EnvironmentId, ProviderApprovalDecision, ThreadId } from "@ryco/contracts";
import type { PendingApproval } from "@ryco/client-runtime/state/session";

import { AppText as Text } from "../../components/AppText";
import { ensureEnvironmentApi } from "../../connection/environmentApi";
import { respondToThreadApproval } from "./sessionActions";

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
  const [pending, setPending] = useState<ProviderApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);

  const respond = async (decision: ProviderApprovalDecision) => {
    setPending(decision);
    setError(null);
    try {
      await respondToThreadApproval({
        api: ensureEnvironmentApi(props.environmentId),
        threadId: props.threadId,
        requestId: props.approval.requestId,
        decision,
        approvalIdentity: props.approval.approvalIdentity,
      });
    } catch {
      // `ensureEnvironmentApi` throws synchronously without a connection, and
      // the RPC itself can reject; without this catch the `void respond(...)`
      // press handler turned both into a silent unhandled rejection. Bounded
      // copy: the raw message is an internal string the user cannot act on.
      setError("The decision could not be delivered. Reconnect and try again.");
    } finally {
      setPending(null);
    }
  };

  return (
    <View className="mx-4 my-2 rounded-2xl border border-warning-border bg-warning-bg p-4">
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
      {props.approval.responseState === "submitting" ||
      props.approval.responseState === "uncertain" ? (
        <Text className="mt-2 text-sm text-foreground-muted">
          Decision submitted. Waiting for provider settlement.
        </Text>
      ) : null}
      {error ? <Text className="mt-2 font-sans text-sm text-danger">{error}</Text> : null}
      <View className="mt-3 flex-row flex-wrap gap-2">
        <Pressable
          disabled={
            pending !== null ||
            props.disabled === true ||
            (props.approval.responseState !== undefined &&
              props.approval.responseState !== "retryable")
          }
          onPress={() => void respond("accept")}
          className="h-11 min-w-28 flex-1 items-center justify-center rounded-full bg-primary px-4 active:opacity-70 disabled:opacity-50"
        >
          <Text className="text-sm font-ryco-bold text-primary-foreground">Allow</Text>
        </Pressable>
        <Pressable
          disabled={
            pending !== null ||
            props.disabled === true ||
            (props.approval.responseState !== undefined &&
              props.approval.responseState !== "retryable")
          }
          onPress={() => void respond("decline")}
          className="h-11 min-w-28 flex-1 items-center justify-center rounded-full border border-border px-4 active:opacity-70 disabled:opacity-50"
        >
          <Text className="text-sm font-ryco-bold text-foreground">Deny</Text>
        </Pressable>
      </View>
    </View>
  );
}
