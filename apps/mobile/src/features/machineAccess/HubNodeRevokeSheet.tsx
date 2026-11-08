import type { HostedHubNode } from "@ryco/client-runtime/authorization";
import {
  hostedNodeRevokeConfirmation,
  hostedNodeRevokeRetryable,
  type HostedNodeRevokeFailure,
} from "@ryco/client-runtime/machineAccess/hostedNodeRevoke";
import { useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { hubNodePlatformLabel } from "./machineAccessModel";
import { attemptHostedNodeRevoke } from "./machineAccessOperations";

/**
 * The confirmation in front of revoking a node from the Hub, with the web
 * dialog's semantics: every sentence and the failure mapping come from the
 * shared revoke module; the sheet names the node by label AND identifier; it
 * cannot be dismissed while the request is in flight (a swipe would hide the
 * Hub's answer to an irreversible action); a failure stays on the sheet; and
 * the action is withdrawn, not greyed, once retrying could not help.
 *
 * `onRevoke` must resolve only once the Hub has confirmed the revocation.
 */
export function HubNodeRevokeSheet(props: {
  readonly node: HostedHubNode;
  readonly onClose: () => void;
  readonly onRevoke: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<HostedNodeRevokeFailure | null>(null);
  const confirmation = hostedNodeRevokeConfirmation(props.node);
  const retryable = hostedNodeRevokeRetryable(failure);

  const close = () => {
    if (!pending) props.onClose();
  };

  const confirm = async () => {
    if (pending) return;
    setPending(true);
    setFailure(null);
    const outcome = await attemptHostedNodeRevoke(props.onRevoke);
    if (outcome === null) {
      props.onClose();
      return;
    }
    setFailure(outcome);
    setPending(false);
  };

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      allowSwipeDismissal={!pending}
      onRequestClose={close}
    >
      <View className="flex-1 bg-screen">
        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40, gap: 18 }}>
          <View className="gap-2">
            <Text className="text-xl font-ryco-bold text-foreground">{confirmation.title}</Text>
            <Text className="font-sans text-sm leading-relaxed text-foreground-muted">
              {confirmation.subjectPrompt}
            </Text>
          </View>

          <View className="overflow-hidden rounded-2xl border border-border bg-card">
            <Fact label="Node" value={props.node.label} first />
            <Fact label="Node ID" value={confirmation.subjectId} mono />
            <Fact label="Platform" value={hubNodePlatformLabel(props.node)} />
          </View>

          <View className="gap-2.5">
            {confirmation.consequences.map((consequence) => (
              <View key={consequence.id} className="flex-row gap-2.5">
                <Text className="font-sans text-sm leading-relaxed text-foreground-muted">•</Text>
                <Text className="min-w-0 flex-1 font-sans text-sm leading-relaxed text-foreground-muted">
                  {consequence.text}
                </Text>
              </View>
            ))}
          </View>

          {failure !== null ? <ErrorBanner message={failure.message} /> : null}

          <View className="gap-2.5">
            {retryable ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: pending, busy: pending }}
                disabled={pending}
                onPress={() => void confirm()}
                className="h-12 items-center justify-center rounded-full bg-danger px-5 active:opacity-80 disabled:opacity-60"
              >
                <Text className="text-base font-ryco-bold text-danger-foreground">
                  {pending ? confirmation.pendingLabel : confirmation.confirmLabel}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              disabled={pending}
              onPress={close}
              className="h-12 items-center justify-center rounded-full border border-border active:bg-subtle disabled:opacity-40"
            >
              <Text className="text-base font-ryco-medium text-foreground">
                {retryable ? confirmation.cancelLabel : confirmation.dismissLabel}
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

function Fact(props: {
  readonly label: string;
  readonly value: string;
  readonly first?: boolean;
  readonly mono?: boolean;
}) {
  return (
    <View
      className={`gap-0.5 px-4 py-3 ${props.first === true ? "" : "border-t border-border-subtle"}`}
    >
      <Text className="text-xs font-ryco-medium text-foreground-muted">{props.label}</Text>
      <Text
        selectable
        className={`text-sm text-foreground ${props.mono === true ? "font-mono" : "font-sans"}`}
      >
        {props.value}
      </Text>
    </View>
  );
}
