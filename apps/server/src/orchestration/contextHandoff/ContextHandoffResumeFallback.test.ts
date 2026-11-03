import {
  CONTEXT_HANDOFF_ACTIVITY_KIND,
  ContextHandoffActivityPayload,
  EventId,
  MessageId,
  ProviderInstanceId,
  RuntimeSessionId,
} from "@ryco/contracts";
import { Option, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  RESUME_FALLBACK_HANDOFF_ID_PREFIX,
  isResumeFallbackHandoffId,
  makeResumeFallbackRequestedActivity,
  resumeFallbackHandoffReference,
} from "./ContextHandoffResumeFallback.ts";

const event = {
  eventId: EventId.make("turn-start-event"),
  payload: { messageId: MessageId.make("message-after-move") },
};
const selection = { instanceId: ProviderInstanceId.make("claude_work"), model: "claude-fable-5" };

describe("resumeFallbackHandoffReference", () => {
  it("derives a stable reference from the turn-start event", () => {
    const reference = resumeFallbackHandoffReference(event);
    expect(reference).toEqual(resumeFallbackHandoffReference(event));
    // The ids written before native-history fallbacks existed: recovery depends on them.
    expect(reference).toEqual({
      handoffId: `${RESUME_FALLBACK_HANDOFF_ID_PREFIX}turn-start-event`,
      activityId: "context-handoff-activity:cwd-relocation:turn-start-event",
      targetMessageId: "message-after-move",
    });
    expect(RESUME_FALLBACK_HANDOFF_ID_PREFIX).toBe("context-handoff:cwd-relocation:");
    expect(isResumeFallbackHandoffId(reference.handoffId)).toBe(true);
    expect(isResumeFallbackHandoffId("context-handoff:command-1")).toBe(false);
  });
});

describe("makeResumeFallbackRequestedActivity", () => {
  it.each(["cwd-relocation", "native-history-unavailable"] as const)(
    "builds the requested activity the coordinator validates (%s)",
    (reason) => {
      const reference = resumeFallbackHandoffReference(event);
      const activity = makeResumeFallbackRequestedActivity({
        reason,
        reference,
        sourceSelection: selection,
        targetSelection: selection,
        sourceRuntimeSessionId: RuntimeSessionId.make("runtime-a1"),
        createdAt: "2026-10-07T00:00:00.000Z",
      });
      expect(activity).toMatchObject({
        id: reference.activityId,
        kind: CONTEXT_HANDOFF_ACTIVITY_KIND,
        tone: "info",
        turnId: null,
        createdAt: "2026-10-07T00:00:00.000Z",
      });
      const payload = Option.getOrUndefined(
        Schema.decodeUnknownOption(ContextHandoffActivityPayload)(activity.payload),
      );
      expect(payload).toEqual({
        schemaVersion: 1,
        handoffId: reference.handoffId,
        mode: "full-context-fresh-session",
        reason,
        status: "requested",
        targetMessageId: reference.targetMessageId,
        sourceSelection: selection,
        targetSelection: selection,
        sourceRuntimeSessionId: "runtime-a1",
      });
    },
  );

  it("omits an unknown source runtime", () => {
    const activity = makeResumeFallbackRequestedActivity({
      reason: "cwd-relocation",
      reference: resumeFallbackHandoffReference(event),
      sourceSelection: selection,
      targetSelection: selection,
      sourceRuntimeSessionId: undefined,
      createdAt: "2026-10-07T00:00:00.000Z",
    });
    expect(activity.payload).not.toHaveProperty("sourceRuntimeSessionId");
  });
});
