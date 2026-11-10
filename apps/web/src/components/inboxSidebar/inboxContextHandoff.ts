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
import { isModelChangeHandoff } from "@ryco/client-runtime/state/session";
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
 * The latest completed model transfer. A working-directory relocation or a
 * fork's first fresh session keeps its model, so neither answers "how did this
 * thread get to this model": the transfer before it still does.
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
      isModelChangeHandoff(decoded.value)
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

type HandoffPayload = NonNullable<ReturnType<typeof latestInboxContextHandoff>>;

/**
 * What a hover already learned about one thread: the latest model transfer
 * among every activity up to `throughSequence`. Activities are only appended,
 * so a later hover reads the newest window and stops at the first activity it
 * has seen before, instead of paging through the whole history again (the
 * owner's trace: 2,545 history pages in 103 hovers, up to 57 pages each).
 */
interface HandoffScan {
  readonly latest: HandoffPayload | null;
  readonly throughSequence: number;
}

const MAX_REMEMBERED_THREADS = 200;
/** Per connection's API: a new connection starts over. */
const scansByApi = new WeakMap<EnvironmentApi, Map<ThreadId, HandoffScan>>();

function rememberScan(api: EnvironmentApi, threadId: ThreadId, scan: HandoffScan): void {
  let scans = scansByApi.get(api);
  if (!scans) {
    scans = new Map();
    scansByApi.set(api, scans);
  }
  scans.delete(threadId);
  scans.set(threadId, scan);
  for (const oldest of scans.keys()) {
    if (scans.size <= MAX_REMEMBERED_THREADS) break;
    scans.delete(oldest);
  }
}

/** The newest sequence of `activities`, or null when one has none (nothing can be remembered). */
function newestSequence(activities: ReadonlyArray<OrchestrationThreadActivity>): number | null {
  let newest = -1;
  for (const activity of activities) {
    if (activity.sequence === undefined) return null;
    newest = Math.max(newest, activity.sequence);
  }
  return newest;
}

/** The latest model transfer, or undefined when the read stopped without an answer. */
async function scanLatestHandoff(
  api: EnvironmentApi,
  threadId: ThreadId,
  cancelled: () => boolean,
): Promise<HandoffPayload | null | undefined> {
  if (!api.orchestration.getThreadWindow) return undefined;
  const snapshot = await api.orchestration.getThreadWindow({
    threadId,
    limits: { messages: 1, proposedPlans: 1, activities: 100, checkpoints: 1 },
  });
  const known = scansByApi.get(api)?.get(threadId);
  const throughSequence = newestSequence(snapshot.thread.activities);
  const finish = (latest: HandoffPayload | null) => {
    if (throughSequence !== null) {
      rememberScan(api, threadId, {
        latest,
        throughSequence: Math.max(throughSequence, known?.throughSequence ?? -1),
      });
    }
    return latest;
  };
  let activities = snapshot.thread.activities;
  let page = snapshot.history.activities;
  while (!cancelled()) {
    const unseen = known
      ? activities.filter((activity) => (activity.sequence ?? -1) > known.throughSequence)
      : activities;
    const latest = latestInboxContextHandoff(unseen);
    if (latest) return finish(latest);
    // Reached what an earlier hover read: its answer still holds.
    if (known && unseen.length < activities.length) return finish(known.latest);
    if (!page.hasMoreBefore || !page.oldestCursor) return finish(known?.latest ?? null);
    if (!api.orchestration.getThreadHistoryPage) return undefined;
    const previousCursor = page.oldestCursor;
    const history = await api.orchestration.getThreadHistoryPage({
      threadId,
      collection: "activities",
      mode: { kind: "before", cursor: previousCursor },
      limit: 100,
    });
    if (history.collection !== "activities") return undefined;
    activities = history.items;
    page = history.page;
    if (page.oldestCursor === previousCursor && page.hasMoreBefore) return undefined;
  }
  return undefined;
}

export async function loadInboxContextHandoff(
  api: EnvironmentApi,
  threadId: ThreadId,
  selection: ModelSelection,
  cancelled: () => boolean,
): Promise<InboxContextHandoff | null> {
  const latest = await scanLatestHandoff(api, threadId, cancelled);
  if (!latest) return null;
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
