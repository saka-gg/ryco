import {
  OrchestrationThreadHistoryCursor,
  type OrchestrationThreadHistoryCollection,
  type ThreadId,
} from "@ryco/contracts";
import { isRecord } from "@ryco/shared/unknownValue";

export type CreatedAtCursorOrder = {
  readonly createdAt: string;
  readonly id: string;
};

export type ActivityCursorOrder = CreatedAtCursorOrder & {
  readonly sequence: number | null;
};

export type CheckpointCursorOrder = {
  readonly checkpointTurnCount: number;
  readonly id: string;
};

export type ThreadHistoryCursorOrder =
  | CreatedAtCursorOrder
  | ActivityCursorOrder
  | CheckpointCursorOrder;

interface ThreadHistoryCursorPayload {
  readonly version: 1;
  readonly threadId: string;
  readonly collection: OrchestrationThreadHistoryCollection;
  readonly order: ThreadHistoryCursorOrder;
}

export type ThreadHistoryCursorDecodeResult =
  | { readonly ok: true; readonly order: ThreadHistoryCursorOrder }
  | {
      readonly ok: false;
      readonly reason: "invalid-cursor" | "unsupported-version";
    };

function isOrderForCollection(
  collection: OrchestrationThreadHistoryCollection,
  value: unknown,
): value is ThreadHistoryCursorOrder {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {
    return false;
  }
  if (collection === "checkpoints") {
    return (
      typeof value.checkpointTurnCount === "number" &&
      Number.isSafeInteger(value.checkpointTurnCount) &&
      value.checkpointTurnCount >= 0
    );
  }
  if (
    typeof value.createdAt !== "string" ||
    value.createdAt.length === 0 ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    return false;
  }
  if (collection === "activities") {
    return (
      value.sequence === null ||
      (typeof value.sequence === "number" &&
        Number.isSafeInteger(value.sequence) &&
        value.sequence >= 0)
    );
  }
  return true;
}

export function encodeThreadHistoryCursor(input: {
  readonly threadId: ThreadId;
  readonly collection: OrchestrationThreadHistoryCollection;
  readonly order: ThreadHistoryCursorOrder;
}): OrchestrationThreadHistoryCursor {
  const payload: ThreadHistoryCursorPayload = {
    version: 1,
    threadId: input.threadId,
    collection: input.collection,
    order: input.order,
  };
  return OrchestrationThreadHistoryCursor.make(
    `v1.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`,
  );
}

export function decodeThreadHistoryCursor(
  cursor: OrchestrationThreadHistoryCursor,
  expected: {
    readonly threadId: ThreadId;
    readonly collection: OrchestrationThreadHistoryCollection;
  },
): ThreadHistoryCursorDecodeResult {
  const separatorIndex = cursor.indexOf(".");
  if (separatorIndex <= 0) {
    return { ok: false, reason: "invalid-cursor" };
  }
  const prefix = cursor.slice(0, separatorIndex);
  if (prefix !== "v1") {
    return {
      ok: false,
      reason: /^v\d+$/.test(prefix) ? "unsupported-version" : "invalid-cursor",
    };
  }

  try {
    const payload: unknown = JSON.parse(
      Buffer.from(cursor.slice(separatorIndex + 1), "base64url").toString("utf8"),
    );
    if (
      !isRecord(payload) ||
      payload.version !== 1 ||
      payload.threadId !== expected.threadId ||
      payload.collection !== expected.collection ||
      !isOrderForCollection(expected.collection, payload.order)
    ) {
      return { ok: false, reason: "invalid-cursor" };
    }
    return { ok: true, order: payload.order };
  } catch {
    return { ok: false, reason: "invalid-cursor" };
  }
}
