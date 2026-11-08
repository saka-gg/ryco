import { useState } from "react";
import { useNavigation } from "@react-navigation/native";
import { Pressable, View } from "react-native";

import type { AgentControlProposalView, EnvironmentId, ThreadId } from "@ryco/contracts";

import { AppText as Text } from "../../components/AppText";
import { ensureEnvironmentApi } from "../../connection/environmentApi";
import { runThenSettle } from "../../lib/runWhileBusy";
import { buildAgentControlProposalCardModel } from "../../state/agentControlRuntime";
import {
  AgentControlCopyPreview,
  useAgentControlCopyApproval,
} from "../projectCopy/AgentControlCopyApproval";
import { acceptAgentControlProposal, rejectAgentControlProposal } from "./agentControlActions";

/**
 * Sends the decision: a proposal this phone runs itself (a copy) is approved
 * by running it here, every other one through the node's accept / reject.
 */
async function submitDecision(input: {
  readonly decision: "accept" | "reject";
  readonly environmentId: EnvironmentId;
  readonly proposalId: AgentControlProposalView["proposalId"];
  readonly approveHere: (() => Promise<void>) | null;
}): Promise<void> {
  if (input.decision === "accept" && input.approveHere) {
    await input.approveHere();
    return;
  }
  const api = ensureEnvironmentApi(input.environmentId);
  if (input.decision === "accept") {
    await acceptAgentControlProposal({ api, proposalId: input.proposalId });
    return;
  }
  await rejectAgentControlProposal({ api, proposalId: input.proposalId });
}

/**
 * Native Agent Control proposal card. Renders the shared presentation
 * model, including the exact immutable plan the user is deciding on, and
 * sends explicit accept/reject decisions through the EnvironmentApi seam.
 * Terminal proposals render their outcome without actions. A plan this build
 * cannot read offers Reject only; a copy to another machine is approved and
 * run from the phone when it can reach the target
 * (`projectCopy/AgentControlCopyApproval`).
 */
export function AgentControlProposalCard(props: {
  readonly environmentId: EnvironmentId;
  readonly proposal: AgentControlProposalView;
  /** Cached/degraded threads render the proposal but cannot decide it. */
  readonly disabled?: boolean;
  /** Opens a thread the receipt links to; defaults to pushing it (a sheet closes first). */
  readonly onOpenThread?: (threadId: ThreadId) => void;
}) {
  const navigation = useNavigation();
  const [pending, setPending] = useState<"accept" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const model = buildAgentControlProposalCardModel(props.proposal);
  const copy = useAgentControlCopyApproval({
    environmentId: props.environmentId,
    proposal: props.proposal,
    model,
  });
  const decisions = copy.decisions;
  const openThread = (threadId: ThreadId) =>
    props.onOpenThread
      ? props.onOpenThread(threadId)
      : navigation.navigate("Thread", { environmentId: props.environmentId, threadId });

  const decide = async (decision: "accept" | "reject") => {
    if (decision === "accept" && !decisions.canApprove) return;
    setPending(decision);
    setError(null);
    await runThenSettle(
      async () => {
        try {
          await submitDecision({
            decision,
            environmentId: props.environmentId,
            proposalId: props.proposal.proposalId,
            approveHere: copy.approve,
          });
        } catch (cause) {
          // Stale/conflicting decisions land here; the queue subscription
          // delivers the authoritative proposal state alongside this message.
          setError(
            cause instanceof Error && cause.message.length > 0
              ? cause.message
              : "Failed to submit the decision.",
          );
        }
      },
      () => setPending(null),
    );
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
      {model.requiresClientExecutor ? (
        <AgentControlCopyPreview
          executor={copy.executor}
          environmentId={props.environmentId}
          proposal={props.proposal}
          enabled={model.isPending && decisions.canApprove}
        />
      ) : null}
      {model.outcomeLabel !== null ? (
        <Text className="mt-1 font-mono text-sm text-foreground-muted" numberOfLines={3}>
          {model.outcomeLabel}
        </Text>
      ) : null}
      {model.completionReturns?.map((result) => (
        <View key={result.childThreadId} className="mt-2 rounded-xl bg-subtle px-3 py-2">
          <Text className="font-ryco-bold text-sm text-foreground">
            Completion return · {result.status}
          </Text>
          <Text className="font-sans text-sm text-foreground-muted">{result.detail}</Text>
          <Pressable
            accessibilityRole="link"
            onPress={() => openThread(result.childThreadId)}
            className="min-h-11 justify-center"
          >
            <Text className="text-sm text-primary">Open child task</Text>
          </Pressable>
          <Pressable
            accessibilityRole="link"
            onPress={() => openThread(result.parentThreadId)}
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
          {decisions.approveUnavailableLabel !== null ? (
            <Text className="w-full font-sans text-sm text-foreground-muted">
              {decisions.approveUnavailableLabel}
            </Text>
          ) : null}
          {decisions.canApprove ? (
            <Pressable
              disabled={pending !== null || props.disabled === true}
              onPress={() => void decide("accept")}
              className="h-11 min-w-28 flex-1 items-center justify-center rounded-full bg-primary px-4 active:opacity-70 disabled:opacity-50"
            >
              <Text className="text-sm font-ryco-bold text-primary-foreground">Approve</Text>
            </Pressable>
          ) : null}
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
