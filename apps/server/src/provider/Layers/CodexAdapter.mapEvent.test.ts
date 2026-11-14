import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ThreadId,
  type ProviderEvent,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mapToRuntimeEvents } from "./CodexAdapter.mapEvent.ts";

const threadId = ThreadId.make("thread-1");

function notification(method: string, fields: Partial<ProviderEvent> = {}): ProviderEvent {
  return {
    id: EventId.make(`evt-${method}`),
    kind: "notification",
    provider: ProviderDriverKind.make("codex"),
    threadId,
    createdAt: "2026-11-14T00:00:00.000Z",
    method,
    ...fields,
  };
}

describe("mapToRuntimeEvents", () => {
  it("maps unknown methods, including Object.prototype names, to no events", () => {
    for (const method of ["thread/unknown", "toString", "constructor", "__proto__"]) {
      expect(mapToRuntimeEvents(notification(method), threadId)).toEqual([]);
    }
  });

  it("maps a decision only when it names its request", () => {
    expect(mapToRuntimeEvents(notification("item/requestApproval/decision"), threadId)).toEqual([]);
    const [event] = mapToRuntimeEvents(
      notification("item/requestApproval/decision", {
        requestId: ApprovalRequestId.make("req-1"),
      }),
      threadId,
    );
    expect(event?.type).toBe("request.resolved");
  });

  it("marks only session/closed as a graceful exit", () => {
    const [exited] = mapToRuntimeEvents(notification("session/exited"), threadId);
    const [closed] = mapToRuntimeEvents(notification("session/closed"), threadId);
    expect(exited?.type).toBe("session.exited");
    expect(exited?.payload).toEqual({});
    expect(closed?.payload).toEqual({ exitKind: "graceful" });
  });

  it("maps an error-kind event before any method mapper", () => {
    const [event] = mapToRuntimeEvents(
      notification("session/exited", { kind: "error", message: "boom" }),
      threadId,
    );
    expect(event?.type).toBe("runtime.error");
  });
});
