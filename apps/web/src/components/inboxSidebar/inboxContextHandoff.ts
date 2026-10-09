import {
  CONTEXT_HANDOFF_ACTIVITY_KIND,
  ContextHandoffActivityPayload,
  type ContextHandoffEndpointSnapshot,
  type EnvironmentApi,
  type ModelSelection,
  type OrchestrationThreadActivity,
  type ProviderDriverKind,
  type ThreadId,
} from "@ryco/contracts";
import { isCwdRelocationHandoff } from "@ryco/client-runtime/state/session";
import { Schema } from "effect";

export function inboxModelName(name: string, driver: ProviderDriverKind): string {
  return driver === "claudeAgent" ? name.replace(/^Claude\s+/i, "") : name;
}

export interface InboxContextHandoff {
  readonly source: ContextHandoffEndpointSnapshot;
  readonly target: ContextHandoffEndpointSnapshot;
}

const decodeHandoff = Schema.decodeUnknownOption(ContextHandoffActivityPayload);

/**
 * The latest completed model transfer. A working-directory relocation keeps
 * its model, so it never answers "how did this thread get to this model": the
 * transfer before it still does.
 */
export function latestInboxContextHandoff(activities: ReadonlyArray<OrchestrationThreadActivity>) {
  const ordered = activities.toSorted(
    (a, b) =>
      (b.sequence ?? 0) - (a.sequence ?? 0) ||
      b.createdAt.localeCompare(a.createdAt) ||
      b.id.localeCompare(a.id),
  );
  for (const activity of ordered) {
    if (activity.kind !== CONTEXT_HANDOFF_ACTIVITY_KIND) continue;
    const decoded = decodeHandoff(activity.payload);
    if (
      decoded._tag === "Some" &&
      decoded.value.status === "consumed" &&
      !isCwdRelocationHandoff(decoded.value)
    ) {
      return decoded.value;
    }
  }
  return null;
}

function displayEndpoint(endpoint: ContextHandoffEndpointSnapshot): ContextHandoffEndpointSnapshot {
  return {
    ...endpoint,
    ...(endpoint.modelDisplayName
      ? { modelDisplayName: inboxModelName(endpoint.modelDisplayName, endpoint.driverKind) }
      : {}),
  };
}

export async function loadInboxContextHandoff(
  api: EnvironmentApi,
  threadId: ThreadId,
  selection: ModelSelection,
  cancelled: () => boolean,
): Promise<InboxContextHandoff | null> {
  if (!api.orchestration.getThreadWindow) return null;
  const snapshot = await api.orchestration.getThreadWindow({
    threadId,
    limits: { messages: 1, proposedPlans: 1, activities: 100, checkpoints: 1 },
  });
  let activities = snapshot.thread.activities;
  let page = snapshot.history.activities;
  while (!cancelled()) {
    const latest = latestInboxContextHandoff(activities);
    if (latest) {
      // Never present an older transfer as the current routing target.
      if (
        latest.targetSelection.instanceId !== selection.instanceId ||
        latest.targetSelection.model !== selection.model
      )
        return null;
      const source = latest.sources.find(
        (endpoint) =>
          endpoint.providerInstanceId === latest.sourceSelection.instanceId &&
          endpoint.modelSlug === latest.sourceSelection.model,
      );
      return source
        ? { source: displayEndpoint(source), target: displayEndpoint(latest.target) }
        : null;
    }
    if (!page.hasMoreBefore || !page.oldestCursor || !api.orchestration.getThreadHistoryPage)
      return null;
    const previousCursor = page.oldestCursor;
    const history = await api.orchestration.getThreadHistoryPage({
      threadId,
      collection: "activities",
      mode: { kind: "before", cursor: previousCursor },
      limit: 100,
    });
    if (history.collection !== "activities") return null;
    activities = history.items;
    page = history.page;
    if (page.oldestCursor === previousCursor && page.hasMoreBefore) return null;
  }
  return null;
}
