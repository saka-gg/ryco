import type { OrchestrationThreadActivity } from "@ryco/contracts";

import { projectActivityPayload, withoutHtmlRenderToolMarkup } from "./ActivityPayloadProjection.ts";
import { ACTIVITY_DATA_STRING_CAP, capActivityData } from "./activityDataCap.ts";

/** The tool lifecycle kinds ingestion bounds before persisting. */
export const BOUNDED_TOOL_ACTIVITY_KINDS = ["tool.started", "tool.updated", "tool.completed"] as const;

/**
 * Only a stored payload larger than this can hold a string over the data cap
 * (every character encodes to at least one byte), so smaller rows are already
 * in today's shape as far as size goes and are never rewritten.
 */
export const LEGACY_ACTIVITY_PAYLOAD_MIN_BYTES = ACTIVITY_DATA_STRING_CAP;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The payload ingestion writes today for a tool lifecycle activity, from one
 * written before tool data was bounded (#481 projected `tool.updated`, #508
 * capped every tool string, #685 dropped HTML tool pages). Returns null when
 * the payload is already in that shape.
 */
export function reprojectLegacyToolActivityPayload(
  activity: Pick<OrchestrationThreadActivity, "id" | "kind" | "payload">,
): unknown {
  const payload = asRecord(activity.payload);
  if (!payload || !("data" in payload)) return null;
  const data = capActivityData(payload.itemType, withoutHtmlRenderToolMarkup(payload.data));
  const capped = data === payload.data ? payload : { ...payload, data };
  const next =
    activity.kind === "tool.updated"
      ? projectActivityPayload({
          id: activity.id,
          tone: "tool",
          kind: activity.kind,
          summary: "Tool updated",
          payload: capped,
          turnId: null,
          createdAt: "1970-01-01T00:00:00.000Z",
        }).payload
      : capped;
  return next === payload || JSON.stringify(next) === JSON.stringify(payload) ? null : next;
}
