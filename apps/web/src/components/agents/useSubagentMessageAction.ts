import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  subagentMessageRequest,
  type SubagentMessageAction,
} from "@ryco/client-runtime/state/session/subagentMessage";
import { ORCHESTRATION_WS_METHODS, type ScopedThreadRef } from "@ryco/contracts";
import { useMemo } from "react";

import { readEnvironmentApi } from "~/environmentApi";
import { readHostedRpcCapability } from "~/hostedHub/capabilities";
import { useHostedHubStore } from "~/hostedHub/state";
import { hostedSwitchTargetLabel } from "~/hostedHub/switchTarget";
import { subagentStopRefusal } from "./agentStop.logic";
import { useSubagentActionAvailability } from "./useSubagentActionAvailability";

const MESSAGE_METHOD = ORCHESTRATION_WS_METHODS.messageBackgroundTask;
const MESSAGE_REFUSED = "Messaging agents is unavailable on this connection.";

/**
 * Messages for the running agents of one thread, or null without a thread or when the user's
 * role on its node may not send them. Gated like Stop (`useSubagentStopAction`): on the exact
 * method, re-read at send time.
 */
export function useSubagentMessageAction(
  threadRef: ScopedThreadRef | null,
): SubagentMessageAction | null {
  const environmentId = threadRef?.environmentId ?? null;
  const threadId = threadRef?.threadId ?? null;
  const { hidden, unavailableReason, runtimeSessionId } = useSubagentActionAvailability(
    threadRef,
    MESSAGE_METHOD,
    MESSAGE_REFUSED,
  );

  return useMemo<SubagentMessageAction | null>(() => {
    if (environmentId === null || threadId === null || hidden) return null;
    return {
      threadRef: scopeThreadRef(environmentId, threadId),
      runtimeSessionId,
      unavailableReason,
      send: async (identity, text) => {
        const refusal = subagentStopRefusal(
          readHostedRpcCapability(MESSAGE_METHOD, environmentId),
          hostedSwitchTargetLabel(useHostedHubStore.getState(), environmentId),
          MESSAGE_REFUSED,
        );
        if (refusal !== null) throw new Error(refusal);
        const message = readEnvironmentApi(environmentId)?.orchestration.messageBackgroundTask;
        if (!message) throw new Error("This environment can't send messages to agents.");
        await message(subagentMessageRequest(threadId, identity, text));
      },
    };
  }, [environmentId, hidden, runtimeSessionId, threadId, unavailableReason]);
}
