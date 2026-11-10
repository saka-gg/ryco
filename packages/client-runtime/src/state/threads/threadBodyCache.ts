import { EventId, TurnId, type ThreadId } from "@ryco/contracts/base-schemas";
import type { EnvironmentId } from "@ryco/contracts/base-schemas";
import type { OrchestrationThreadActivity } from "@ryco/contracts/orchestration";

import { scopeThreadRef } from "../../scoped.ts";
import { derivePendingApprovals, derivePendingUserInputs } from "../session/session-logic.ts";
import type { CachedThreadContent } from "./readCache.ts";
import type { AppState, EnvironmentState } from "./store.ts";
import { holdsLiveThreadBody } from "./threadBodyResidency.ts";

/**
 * A display-only saved copy of one thread's body beyond its message text
 * (`readCache.ts`): the approval and question cards still open when it was
 * saved, as the minimal activity rows the thread view derives those cards from
 * (`derivePendingApprovals`, `derivePendingUserInputs`). Never a replay
 * baseline: answering a card goes through the live connection, and the request
 * id it carries names exactly the request it was saved for. Pure: the platform
 * that owns the cache stores the rows.
 */

/** Open cards one thread's saved body holds at most. */
export const CACHED_THREAD_PROMPT_LIMIT = 8;
/** Longest serialized payload of one saved card; a longer one is not saved. */
export const CACHED_THREAD_PROMPT_PAYLOAD_CHARS = 32_000;

const PROMPT_REQUEST_KINDS: ReadonlySet<string> = new Set([
  "approval.requested",
  "user-input.requested",
]);
const ACTIVITY_TONES: ReadonlySet<string> = new Set(["info", "tool", "approval", "error"]);

/** The payload fields the card derivations read, by the type each must have. */
const PROMPT_PAYLOAD_FIELDS = {
  requestId: "string",
  requestKind: "string",
  requestType: "string",
  approvalIdentity: "object",
  detail: "string",
  reason: "string",
  acceptForSessionOffered: "boolean",
  userInputIdentity: "object",
  nonBlocking: "boolean",
  itemId: "string",
  questions: "array",
} as const;

function allowlistedPayload(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const source = payload as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const [field, type] of Object.entries(PROMPT_PAYLOAD_FIELDS)) {
    const value = source[field];
    if (value === undefined) continue;
    if (type === "array" ? Array.isArray(value) : typeof value === type && value !== null) {
      kept[field] = value;
    }
  }
  return typeof kept.requestId === "string" ? kept : null;
}

/**
 * The request activities of the approval and question cards still open (not
 * answered yet), with their payload cut to the fields those cards read. At most
 * `CACHED_THREAD_PROMPT_LIMIT`, the newest kept.
 */
export function captureOpenPromptActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationThreadActivity[] {
  const open = new Set<string>();
  for (const approval of derivePendingApprovals(activities)) {
    if (approval.responseState === undefined) {
      open.add(`approval.requested\u0000${approval.requestId}\u0000${approval.createdAt}`);
    }
  }
  for (const input of derivePendingUserInputs(activities)) {
    if (input.responseState === undefined) {
      open.add(`user-input.requested\u0000${input.requestId}\u0000${input.createdAt}`);
    }
  }
  if (open.size === 0) return [];
  const kept: OrchestrationThreadActivity[] = [];
  const seen = new Set<string>();
  for (const activity of activities) {
    if (!PROMPT_REQUEST_KINDS.has(activity.kind)) continue;
    const payload = allowlistedPayload(activity.payload);
    if (payload === null) continue;
    const key = `${activity.kind}\u0000${String(payload.requestId)}\u0000${activity.createdAt}`;
    if (!open.has(key) || seen.has(key)) continue;
    if (JSON.stringify(payload).length > CACHED_THREAD_PROMPT_PAYLOAD_CHARS) continue;
    seen.add(key);
    kept.push({
      id: activity.id,
      tone: activity.tone,
      kind: activity.kind,
      summary: activity.summary,
      payload,
      turnId: activity.turnId,
      ...(activity.sequence === undefined ? {} : { sequence: activity.sequence }),
      createdAt: activity.createdAt,
    });
  }
  return kept.slice(-CACHED_THREAD_PROMPT_LIMIT);
}

/** Saved card rows as this build reads them; anything that does not decode is left out. */
export function decodeOpenPromptActivities(value: unknown): OrchestrationThreadActivity[] {
  if (!Array.isArray(value)) return [];
  const decoded: OrchestrationThreadActivity[] = [];
  const ids = new Set<string>();
  for (const item of value.slice(0, CACHED_THREAD_PROMPT_LIMIT)) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      row.id.length === 0 ||
      ids.has(row.id) ||
      typeof row.kind !== "string" ||
      !PROMPT_REQUEST_KINDS.has(row.kind) ||
      typeof row.tone !== "string" ||
      !ACTIVITY_TONES.has(row.tone) ||
      typeof row.summary !== "string" ||
      row.summary.trim().length === 0 ||
      typeof row.createdAt !== "string" ||
      (row.turnId !== null && typeof row.turnId !== "string") ||
      (row.sequence !== undefined &&
        (typeof row.sequence !== "number" || !Number.isInteger(row.sequence) || row.sequence < 0))
    ) {
      continue;
    }
    const payload = allowlistedPayload(row.payload);
    if (payload === null || JSON.stringify(payload).length > CACHED_THREAD_PROMPT_PAYLOAD_CHARS) {
      continue;
    }
    ids.add(row.id);
    decoded.push({
      id: EventId.make(row.id),
      tone: row.tone as OrchestrationThreadActivity["tone"],
      kind: row.kind,
      summary: row.summary,
      payload,
      turnId: typeof row.turnId === "string" ? TurnId.make(row.turnId) : null,
      ...(typeof row.sequence === "number" ? { sequence: row.sequence } : {}),
      createdAt: row.createdAt,
    });
  }
  return decoded;
}

/** One thread's saved body for `hydrateCachedThreadBodies`. */
export interface CachedThreadBodyHydration {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly content: CachedThreadContent | null;
  readonly prompts: ReadonlyArray<OrchestrationThreadActivity>;
}

function ownEntry<V>(record: Readonly<Record<string, V>> | undefined, key: string): V | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * Whether live data already gave the store this thread's body (a window, a
 * history page, a live message, or a send waiting for its echo): a saved copy
 * never replaces it.
 */
function holdsLiveBody(
  state: AppState,
  environmentState: EnvironmentState,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): boolean {
  return (
    holdsLiveThreadBody(state, scopeThreadRef(environmentId, threadId)) ||
    ownEntry(environmentState.threadHistoryByThreadId ?? {}, threadId) !== undefined ||
    (ownEntry(environmentState.pendingMessagesByThreadId, threadId)?.length ?? 0) > 0
  );
}

/**
 * Puts saved thread bodies into the store as display-only state: messages
 * marked in `cachedMessageThreadIds` and the open cards as activities, which
 * the thread's first live window replaces like any body. An entry is skipped
 * when its environment or thread is not in the store, or when live data
 * already gave the thread a body, so a late saved copy never covers live data.
 */
export function hydrateCachedThreadBodies(
  state: AppState,
  entries: ReadonlyArray<CachedThreadBodyHydration>,
): AppState {
  // Copied once, on the first entry that changes anything.
  let environmentStateById: Record<string, EnvironmentState> | null = null;
  for (const entry of entries) {
    const environmentState = ownEntry(
      environmentStateById ?? state.environmentStateById,
      entry.environmentId,
    );
    const { threadId } = entry;
    if (
      environmentState === undefined ||
      ownEntry(environmentState.threadShellById, threadId) === undefined ||
      holdsLiveBody(
        environmentStateById === null ? state : { ...state, environmentStateById },
        environmentState,
        entry.environmentId,
        threadId,
      )
    ) {
      continue;
    }
    const messages = entry.content?.messages ?? [];
    if (messages.length === 0 && entry.prompts.length === 0) continue;
    let next: EnvironmentState = environmentState;
    if (messages.length > 0) {
      next = {
        ...next,
        cachedMessageThreadIds: { ...next.cachedMessageThreadIds, [threadId]: true },
        messageIdsByThreadId: {
          ...next.messageIdsByThreadId,
          [threadId]: messages.map((message) => message.id),
        },
        messageByThreadId: {
          ...next.messageByThreadId,
          [threadId]: Object.fromEntries(
            messages.map((message) => [message.id, { ...message, streaming: false }]),
          ),
        },
      };
    }
    if (entry.prompts.length > 0) {
      next = {
        ...next,
        activityIdsByThreadId: {
          ...next.activityIdsByThreadId,
          [threadId]: entry.prompts.map((activity) => activity.id),
        },
        activityByThreadId: {
          ...next.activityByThreadId,
          [threadId]: Object.fromEntries(entry.prompts.map((activity) => [activity.id, activity])),
        },
      };
    }
    environmentStateById ??= { ...state.environmentStateById };
    environmentStateById[entry.environmentId] = next;
  }
  return environmentStateById === null ? state : { ...state, environmentStateById };
}
