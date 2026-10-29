import { ThreadId, type ProviderInstanceId } from "@ryco/contracts";
import { createModelSelection } from "@ryco/shared/model";

import { buildThreadPriorityChunks } from "./threadPriorityPolicy.ts";

export function makeThreadPriorityTestChunk() {
  const chunks = buildThreadPriorityChunks(
    [
      {
        threadId: ThreadId.make("thread-priority-test"),
        title: "Repair reconnect handling",
        projectName: "Ryco",
        branchName: "main",
        createdAt: "2026-08-25T10:00:00.000Z",
        updatedAt: "2026-08-25T11:30:00.000Z",
        activityState: "idle",
        hasPendingApproval: false,
        hasPendingUserInput: false,
        queueState: "none",
        hasLatestFailure: false,
        deliveryState: "known",
        pullRequest: null,
        issue: null,
        latestUserRequest: "Please repair reconnect handling.",
      },
    ],
    Date.parse("2026-08-25T12:00:00.000Z"),
  );
  const chunk = chunks[0];
  if (chunk === undefined) throw new Error("Expected one thread priority test chunk.");
  return chunk;
}

export function makeThreadPriorityTestInput(instanceId: ProviderInstanceId, model: string) {
  return {
    cwd: process.cwd(),
    chunk: makeThreadPriorityTestChunk(),
    modelSelection: createModelSelection(instanceId, model),
  };
}
