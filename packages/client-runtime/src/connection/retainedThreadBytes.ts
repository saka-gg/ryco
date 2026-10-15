import {
  MAX_THREAD_ACTIVITIES,
  MAX_THREAD_CHECKPOINTS,
  MAX_THREAD_MESSAGES,
  MAX_THREAD_PROPOSED_PLANS,
} from "../state/threads/limits.ts";
import { approximateJsonSize } from "./approximateJsonSize.ts";

/** Fixed per-row overhead (ids, timestamps, envelope) for rows measured from live events. */
export const RETAINED_ROW_OVERHEAD_BYTES = 256;

type RetainedCollection = "messages" | "activities" | "proposedPlans" | "checkpoints";

const COLLECTIONS: ReadonlyArray<{
  readonly name: RetainedCollection;
  readonly maxRows: number;
  readonly rowKey: (row: Record<string, unknown>) => unknown;
}> = [
  { name: "messages", maxRows: MAX_THREAD_MESSAGES, rowKey: (row) => row.id },
  { name: "activities", maxRows: MAX_THREAD_ACTIVITIES, rowKey: (row) => row.id },
  { name: "proposedPlans", maxRows: MAX_THREAD_PROPOSED_PLANS, rowKey: (row) => row.id },
  { name: "checkpoints", maxRows: MAX_THREAD_CHECKPOINTS, rowKey: (row) => row.turnId },
];
const MAX_ROWS = new Map(COLLECTIONS.map((collection) => [collection.name, collection.maxRows]));
const ROW_KEY = new Map(COLLECTIONS.map((collection) => [collection.name, collection.rowKey]));

/**
 * The row a live thread event writes in the client's thread state, and how
 * its size combines with what that row already holds. Streaming message
 * deltas append to their message; activity and plan upserts replace theirs.
 * Other events update rows in place and do not grow retained state.
 */
function retainedRowWrite(event: unknown): {
  readonly collection: RetainedCollection;
  readonly key: string;
  readonly bytes: number;
  readonly append: boolean;
} | null {
  const candidate = event as {
    readonly type?: unknown;
    readonly payload?: Record<string, unknown>;
  } | null;
  const payload = candidate?.payload;
  if (payload === undefined || payload === null) return null;
  switch (candidate?.type) {
    case "thread.message-sent": {
      const text = typeof payload.text === "string" ? payload.text : "";
      return {
        collection: "messages",
        key: String(payload.messageId),
        bytes: text.length,
        append: payload.streaming === true,
      };
    }
    case "thread.activity-appended": {
      const activity = payload.activity as { readonly id?: unknown } | undefined;
      return {
        collection: "activities",
        key: String(activity?.id),
        bytes: approximateJsonSize(activity),
        append: false,
      };
    }
    case "thread.proposed-plan-upserted": {
      const plan = payload.proposedPlan as { readonly id?: unknown } | undefined;
      return {
        collection: "proposedPlans",
        key: String(plan?.id),
        bytes: approximateJsonSize(plan),
        append: false,
      };
    }
    default:
      return null;
  }
}

function asRows(value: unknown): ReadonlyArray<Record<string, unknown>> | null {
  return Array.isArray(value) ? (value as ReadonlyArray<Record<string, unknown>>) : null;
}

/**
 * An estimate of the bytes one cached thread subscription keeps in the client's
 * thread state, for the idle cache's byte budget.
 *
 * Rows are tracked per collection, keyed by row id, so a row that is updated
 * again (a streaming message, a re-sent activity, a history page fetched
 * twice) is counted once. Each collection keeps at most as many rows as the
 * store does and drops its oldest row past that, so a busy thread whose
 * activities the store trims to the last 500 is not counted for every activity
 * it ever produced. Everything outside those rows (the thread record, session,
 * history cursors) is the snapshot's fixed part.
 */
export interface RetainedThreadBytes {
  readonly bytes: () => number;
  readonly recordSnapshot: (snapshot: unknown) => void;
  readonly recordEvent: (event: unknown) => void;
  readonly recordHistoryPage: (page: unknown) => void;
}

export function createRetainedThreadBytes(): RetainedThreadBytes {
  let fixedBytes = 0;
  let rowBytes = 0;
  const rowsByCollection = new Map<RetainedCollection, Map<string, number>>();

  const rowsOf = (collection: RetainedCollection) => {
    let rows = rowsByCollection.get(collection);
    if (rows === undefined) {
      rows = new Map();
      rowsByCollection.set(collection, rows);
    }
    return rows;
  };
  const writeRow = (collection: RetainedCollection, key: string, bytes: number) => {
    const rows = rowsOf(collection);
    const previous = rows.get(key);
    rows.set(key, bytes);
    rowBytes += bytes - (previous ?? 0);
    if (previous !== undefined) return;
    // The store keeps the newest rows of a collection; drop the oldest one.
    const maxRows = MAX_ROWS.get(collection) ?? Number.POSITIVE_INFINITY;
    if (rows.size <= maxRows) return;
    const oldest = rows.keys().next();
    if (oldest.done === true) return;
    rowBytes -= rows.get(oldest.value) ?? 0;
    rows.delete(oldest.value);
  };
  const writeRows = (collection: RetainedCollection, items: ReadonlyArray<unknown>) => {
    const rowKey = ROW_KEY.get(collection);
    if (rowKey === undefined) return;
    const rows = rowsOf(collection);
    for (const item of items) {
      const key = String(rowKey((item ?? {}) as Record<string, unknown>));
      writeRow(collection, key, Math.max(rows.get(key) ?? 0, approximateJsonSize(item)));
    }
  };

  return {
    bytes: () => fixedBytes + rowBytes,
    recordSnapshot: (snapshot) => {
      rowsByCollection.clear();
      rowBytes = 0;
      const thread = (snapshot as { readonly thread?: unknown } | null)?.thread;
      if (thread === null || typeof thread !== "object") {
        fixedBytes = approximateJsonSize(snapshot);
        return;
      }
      const threadRecord = thread as Record<string, unknown>;
      const withoutRows: Record<string, unknown> = { ...threadRecord };
      for (const { name } of COLLECTIONS) {
        const rows = asRows(threadRecord[name]);
        if (rows === null) continue;
        withoutRows[name] = [];
        writeRows(name, rows);
      }
      fixedBytes = approximateJsonSize({ ...(snapshot as object), thread: withoutRows });
    },
    recordEvent: (event) => {
      const write = retainedRowWrite(event);
      if (write === null) return;
      const previous = rowsOf(write.collection).get(write.key);
      const next =
        previous === undefined
          ? write.bytes + RETAINED_ROW_OVERHEAD_BYTES
          : write.append
            ? previous + write.bytes
            : Math.max(previous, write.bytes + RETAINED_ROW_OVERHEAD_BYTES);
      if (next !== previous) writeRow(write.collection, write.key, next);
    },
    recordHistoryPage: (page) => {
      const candidate = page as { readonly collection?: unknown; readonly items?: unknown } | null;
      const items = asRows(candidate?.items);
      const collection = candidate?.collection;
      if (items !== null && typeof collection === "string" && ROW_KEY.has(collection as never)) {
        writeRows(collection as RetainedCollection, items);
        return;
      }
      fixedBytes += approximateJsonSize(candidate?.items ?? page);
    },
  };
}
