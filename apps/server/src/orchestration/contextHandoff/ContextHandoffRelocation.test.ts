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
  CWD_RELOCATION_HANDOFF_ID_PREFIX,
  cwdRelocationHandoffReference,
  isCwdRelocationHandoffId,
  makeCwdRelocationRequestedActivity,
} from "./ContextHandoffRelocation.ts";

const event = {
  eventId: EventId.make("turn-start-event"),
  payload: { messageId: MessageId.make("message-after-move") },
};
const selection = { instanceId: ProviderInstanceId.make("claude_work"), model: "claude-fable-5" };

describe("cwdRelocationHandoffReference", () => {
  it("derives a stable reference from the turn-start event", () => {
    const reference = cwdRelocationHandoffReference(event);
    expect(reference).toEqual(cwdRelocationHandoffReference(event));
    expect(reference).toEqual({
      handoffId: `${CWD_RELOCATION_HANDOFF_ID_PREFIX}turn-start-event`,
      activityId: "context-handoff-activity:cwd-relocation:turn-start-event",
      targetMessageId: "message-after-move",
    });
    expect(isCwdRelocationHandoffId(reference.handoffId)).toBe(true);
    expect(isCwdRelocationHandoffId("context-handoff:command-1")).toBe(false);
  });
});

describe("makeCwdRelocationRequestedActivity", () => {
  it("builds the requested activity the coordinator validates", () => {
    const reference = cwdRelocationHandoffReference(event);
    const activity = makeCwdRelocationRequestedActivity({
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
      reason: "cwd-relocation",
      status: "requested",
      targetMessageId: reference.targetMessageId,
      sourceSelection: selection,
      targetSelection: selection,
      sourceRuntimeSessionId: "runtime-a1",
    });
  });

  it("omits an unknown source runtime", () => {
    const activity = makeCwdRelocationRequestedActivity({
      reference: cwdRelocationHandoffReference(event),
      sourceSelection: selection,
      targetSelection: selection,
      sourceRuntimeSessionId: undefined,
      createdAt: "2026-10-07T00:00:00.000Z",
    });
    expect(activity.payload).not.toHaveProperty("sourceRuntimeSessionId");
  });
});
