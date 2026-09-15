import { EventId } from "@ryco/contracts";
import { expect, it } from "vite-plus/test";
import { deriveThreadBackgroundWork } from "./backgroundWork.ts";
import type { ThreadSession } from "../threads/types.ts";
const session = {
  runtimeSessionId: "current",
  provider: "claudeAgent",
  status: "ready",
  orchestrationStatus: "ready",
  createdAt: "2026-09-15T00:00:00Z",
  updatedAt: "2026-09-15T00:00:00Z",
} as ThreadSession;
const activities = [
  {
    id: EventId.make("task"),
    createdAt: session.createdAt,
    turnId: null,
    tone: "info" as const,
    kind: "task.started",
    summary: "Check tests",
    payload: {
      runtimeSessionId: "current",
      taskId: "task",
      isBackgrounded: true,
      agentKind: "background",
    },
  },
];
it("connection uncertainty does not settle work; confirmed session end does", () => {
  // Transport connectivity is deliberately absent from lifecycle policy.
  expect(deriveThreadBackgroundWork(activities, session).tasks).toHaveLength(1);
  expect(
    deriveThreadBackgroundWork(activities, { ...session, status: "disconnected" }).tasks,
  ).toHaveLength(1);
  expect(deriveThreadBackgroundWork(activities, session).tasks).toHaveLength(1);
  // A failed parent turn also projects error; it is not a process boundary.
  expect(
    deriveThreadBackgroundWork(activities, { ...session, orchestrationStatus: "error" }).tasks,
  ).toHaveLength(1);
  for (const orchestrationStatus of ["stopped", "interrupted"] as const) {
    expect(
      deriveThreadBackgroundWork(activities, { ...session, orchestrationStatus }).tasks,
    ).toEqual([]);
  }
});
it("a replacement runtime cannot revive old tasks even if a boundary notification was missed", () => {
  expect(
    deriveThreadBackgroundWork(activities, { ...session, runtimeSessionId: "replacement" }).tasks,
  ).toEqual([]);
});
