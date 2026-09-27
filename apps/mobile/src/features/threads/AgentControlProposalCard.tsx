import { useState } from "react";
import { useNavigation } from "@react-navigation/native";
import { Pressable, View } from "react-native";

import type { AgentControlProposal, EnvironmentId } from "@ryco/contracts";

import { AppText as Text } from "../../components/AppText";
import { ensureEnvironmentApi } from "../../connection/environmentApi";
import { buildAgentControlProposalCardModel } from "../../state/agentControlRuntime";
import { acceptAgentControlProposal, rejectAgentControlProposal } from "./agentControlActions";

/**
 * Native Agent Control proposal card. Renders the shared presentation
 * model, including the exact immutable plan the user is deciding on, and
 * sends explicit accept/reject decisions through the EnvironmentApi seam.
 * Terminal proposals render their outcome without actions.
 */
export function AgentControlProposalCard(props: {
  readonly environmentId: EnvironmentId;
  readonly proposal: AgentControlProposal;
  /** Cached/degraded threads render the proposal but cannot decide it. */
  readonly disabled?: boolean;
}) {
  const navigation = useNavigation();
  const [pending, setPending] = useState<"accept" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const model = buildAgentControlProposalCardModel(props.proposal);

  const decide = async (decision: "accept" | "reject") => {
    setPending(decision);
    setError(null);
    try {
      const api = ensureEnvironmentApi(props.environmentId);
      if (decision === "accept") {
        await acceptAgentControlProposal({ api, proposalId: props.proposal.proposalId });
      } else {
        await rejectAgentControlProposal({ api, proposalId: props.proposal.proposalId });
      }
    } catch (cause) {
      // Stale/conflicting decisions land here; the queue subscription
      // delivers the authoritative proposal state alongside this message.
      setError(
        cause instanceof Error && cause.message.length > 0
          ? cause.message
          : "Failed to submit the decision.",
      );
    } finally {
      setPending(null);
    }
  };

  return (
    <View
      className={`mx-4 my-2 rounded-2xl border bg-card p-4 ${
        model.isDestructive ? "border-danger-border" : "border-border"
      }`}
    >
      <Text className="text-xs font-ryco-bold uppercase tracking-wide text-foreground-muted">
        Agent Control · {model.statusLabel}
      </Text>
      <Text className="mt-1 font-sans text-base text-foreground">
        {model.actionLabel} · {model.targetLabel}
      </Text>
      {model.isDestructive ? (
        <Text className="mt-1 font-ryco-bold text-sm text-danger-foreground">
          Destructive Ryco record removal · workspace files retained
        </Text>
      ) : null}
      <Text className="mt-0.5 font-sans text-sm text-foreground-muted">
        {model.originLabel}
        {model.runtimeLabel !== null ? ` · ${model.runtimeLabel}` : ""}
      </Text>
      {model.summary !== null ? (
        <Text className="mt-1 font-sans text-sm text-foreground-muted" numberOfLines={3}>
          {model.summary}
        </Text>
      ) : null}
      {model.outcomeLabel !== null ? (
        <Text className="mt-1 font-mono text-sm text-foreground-muted" numberOfLines={3}>
          {model.outcomeLabel}
        </Text>
      ) : null}
      {model.completionReturns?.map((result) => (
        <View key={result.childThreadId} className="mt-2 border-l-2 border-border pl-2">
          <Text className="font-ryco-bold text-sm text-foreground">
            Completion return · {result.status}
          </Text>
          <Text className="font-sans text-sm text-foreground-muted">{result.detail}</Text>
          <Pressable
            accessibilityRole="link"
            onPress={() =>
              navigation.navigate("Thread", {
                environmentId: props.environmentId,
                threadId: result.childThreadId,
              })
            }
            className="min-h-11 justify-center"
          >
            <Text className="text-sm text-primary">Open child task</Text>
          </Pressable>
          <Pressable
            accessibilityRole="link"
            onPress={() =>
              navigation.navigate("Thread", {
                environmentId: props.environmentId,
                threadId: result.parentThreadId,
              })
            }
            className="min-h-11 justify-center"
          >
            <Text className="text-sm text-primary">Open originating chat</Text>
          </Pressable>
        </View>
      ))}
      {model.detailSections.map((section) => (
        <View key={section.heading} className="mt-2 rounded-xl border border-border p-3">
          <Text className="font-ryco-bold text-sm text-foreground">{section.heading}</Text>
          {section.lines.map((line, index) => (
            <Text
              // Immutable plan fragments may repeat; position is stable inside the proposal.
              // eslint-disable-next-line react/no-array-index-key
              key={index}
              className="mt-0.5 font-mono text-xs text-foreground-muted"
            >
              {line}
            </Text>
          ))}
        </View>
      ))}
      {error !== null ? (
        <Text className="mt-1 font-sans text-sm text-danger-foreground" numberOfLines={3}>
          {error}
        </Text>
      ) : null}
      {model.isPending ? (
        <View className="mt-3 flex-row flex-wrap gap-2">
          <Pressable
            disabled={pending !== null || props.disabled === true}
            onPress={() => void decide("accept")}
            className="h-11 min-w-28 flex-1 items-center justify-center rounded-full bg-primary px-4 active:opacity-70 disabled:opacity-50"
          >
            <Text className="text-sm font-ryco-bold text-primary-foreground">Approve</Text>
          </Pressable>
          <Pressable
            disabled={pending !== null || props.disabled === true}
            onPress={() => void decide("reject")}
            className="h-11 min-w-28 flex-1 items-center justify-center rounded-full border border-border px-4 active:opacity-70 disabled:opacity-50"
          >
            <Text className="text-sm font-ryco-bold text-foreground">Reject</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
