import type {
  AgentControlClientExecutionPreviewState,
  AgentControlClientExecutor,
} from "@ryco/client-runtime/projectCopy/agentControlExecutor";
import {
  agentControlCardDecisions,
  type AgentControlCardDecisions,
  type AgentControlProposalCardModel,
} from "@ryco/client-runtime/state/agentControl";
import type { AgentControlProposalView, EnvironmentId } from "@ryco/contracts";
import { displayProjectPath } from "@ryco/shared/projectPaths";
import { useEffect, useSyncExternalStore } from "react";
import { ActivityIndicator, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useMobileAgentControlCopyExecutor } from "./mobileAgentControlCopy";

const NO_PREVIEWS = {
  subscribe: () => () => undefined,
  read: () => null,
} as const;

/** What the card needs to offer Approve for a proposal this phone may run itself. */
export interface AgentControlCopyApproval {
  readonly decisions: AgentControlCardDecisions;
  /** Approves a client-executed proposal and runs its copy here; null for any other proposal. */
  readonly approve: (() => Promise<void>) | null;
  readonly executor: AgentControlClientExecutor;
}

/**
 * The card's decisions with the phone's copy executor: a `copyProjectToNode`
 * request whose target this phone can reach is approved here and its copy runs
 * from the phone, as the desktop does.
 */
export function useAgentControlCopyApproval(input: {
  readonly environmentId: EnvironmentId;
  readonly proposal: AgentControlProposalView;
  readonly model: Pick<
    AgentControlProposalCardModel,
    "unsupportedKind" | "requiresClientExecutor" | "clientExecutionTarget"
  >;
}): AgentControlCopyApproval {
  const executor = useMobileAgentControlCopyExecutor();
  const decisions = agentControlCardDecisions(input.model, executor.canExecute);
  const { environmentId, proposal } = input;
  return {
    decisions,
    executor,
    approve: input.model.requiresClientExecutor
      ? () => executor.approve({ environmentId, proposal })
      : null,
  };
}

function usePreview(
  executor: AgentControlClientExecutor,
  environmentId: EnvironmentId,
  proposal: AgentControlProposalView,
  enabled: boolean,
): AgentControlClientExecutionPreviewState | null {
  const previews = enabled ? (executor.previews ?? null) : null;
  const source = previews ?? NO_PREVIEWS;
  const read = () => source.read(proposal.proposalId);
  const state = useSyncExternalStore(source.subscribe, read, read);
  const missing = previews !== null && state === null;
  useEffect(() => {
    if (missing && previews) previews.load({ environmentId, proposal });
  }, [missing, previews, environmentId, proposal]);
  return previews === null ? null : (state ?? { status: "loading" });
}

/** Where approving puts the copy, resolved on its target before Approve (the desktop card's preview). */
export function AgentControlCopyPreview(props: {
  readonly executor: AgentControlClientExecutor;
  readonly environmentId: EnvironmentId;
  readonly proposal: AgentControlProposalView;
  readonly enabled: boolean;
}) {
  const state = usePreview(props.executor, props.environmentId, props.proposal, props.enabled);
  if (state === null) return null;
  if (state.status === "loading") {
    return (
      <View className="mt-2 flex-row items-center gap-2">
        <ActivityIndicator size="small" />
        <Text className="font-sans text-sm text-foreground-muted">Checking the destination…</Text>
      </View>
    );
  }
  const { preview } = state;
  return (
    <View className="mt-2 gap-1 rounded-xl border border-border p-3">
      <Text className="text-xs font-ryco-medium text-foreground-muted">
        On {preview.targetLabel}
      </Text>
      {preview.destination ? (
        <>
          <View className="flex-row items-center gap-2">
            <Text className="min-w-0 flex-1 font-mono text-xs text-foreground" numberOfLines={2}>
              {displayProjectPath(preview.destination.path)}
            </Text>
            <View className="rounded-full bg-subtle px-2 py-0.5">
              <Text className="text-[11px] font-ryco-medium text-foreground-muted">
                {preview.destination.tag}
              </Text>
            </View>
          </View>
          {preview.destination.note ? (
            <Text className="font-sans text-xs text-foreground-muted">
              {preview.destination.note}
            </Text>
          ) : null}
        </>
      ) : null}
      {preview.sends ? (
        <Text className="font-sans text-xs text-foreground-muted">Sends {preview.sends}</Text>
      ) : null}
      {preview.followUpModel ? (
        <Text className="font-sans text-xs text-foreground-muted">
          Setup agent · {preview.followUpModel}
        </Text>
      ) : null}
      {preview.problem ? (
        <Text className="font-sans text-xs text-danger-foreground">{preview.problem}</Text>
      ) : null}
    </View>
  );
}
