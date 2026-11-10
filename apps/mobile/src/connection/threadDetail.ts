import type {
  ThreadDetailSubscriptionReleaseOptions,
  ThreadDetailSubscriptionRetainOptions,
} from "@ryco/client-runtime/connection";
import type {
  EnvironmentId,
  MessageId,
  OrchestrationThreadHistoryPageInfo,
  ThreadId,
} from "@ryco/contracts";

import { requestSavedThreadBody } from "../persistence/savedThreadBodies";
import { createMobileConnectionRegistry } from "../runtime/bootstrap";
import { mobileHostedConnectionScopes } from "./hostedConnectionScopes";

// Thin wrapper over the supervisor's thread-detail retention (spec Thread-row
// requirement: the Thread screen retains the detail subscription while mounted,
// per apps/web ChatView). Bound to the app's single-homed registry.
const registry = createMobileConnectionRegistry();

export function retainThreadDetailSubscription(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  options?: ThreadDetailSubscriptionRetainOptions,
): () => void {
  // The saved body shows until the live window arrives.
  requestSavedThreadBody(environmentId, threadId);
  const releaseDetail = registry.driver.supervisor.retainThreadDetailSubscription(
    environmentId,
    threadId,
    options,
  );
  const releaseConnectionDetail = mobileHostedConnectionScopes.retain(environmentId, {
    type: "thread-detail",
    threadId,
  });
  // The mounted detail reads serverConfig for the active provider/model/status
  // surfaces. This is a separate scope because another future surface may
  // retain provider status without retaining a thread stream.
  const releaseProvider = mobileHostedConnectionScopes.retain(environmentId, {
    type: "provider-status",
  });
  return () => {
    releaseProvider();
    releaseConnectionDetail();
    releaseDetail();
  };
}

/**
 * A prefetch of the thread's detail (a Home row pressed or near the top), not a view of it:
 * `speculative` in the supervisor, so a body only it fetched is the first the store drops, and
 * no hosted connection scope, so it never connects a machine, or keeps one connected, that
 * nothing else wants. Callers only ask for environments that are live already.
 */
export function retainSpeculativeThreadDetailSubscription(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): (options?: ThreadDetailSubscriptionReleaseOptions) => void {
  requestSavedThreadBody(environmentId, threadId);
  return registry.driver.supervisor.retainThreadDetailSubscription(environmentId, threadId, {
    speculative: true,
  });
}

export function loadOlderThreadMessages(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly page: OrchestrationThreadHistoryPageInfo;
}) {
  return registry.driver.supervisor.loadOlderThreadHistory({
    ...input,
    collection: "messages",
    limit: 100,
  });
}

/**
 * Loads the thread's message history around one message (a link that opens the thread at it),
 * through the same shared supervisor call web uses.
 */
export function loadThreadMessagesAround(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
}) {
  return registry.driver.supervisor.loadThreadHistoryAroundMessage({ ...input, limit: 101 });
}
