import type { EnvironmentId, ThreadId } from "@ryco/contracts";

import { readEnvironmentApi } from "./environmentApi";
import { newCommandId } from "./lib/utils";

/**
 * Undo for deleted conversations: the node keeps a deleted thread hidden for
 * `THREAD_DELETE_GRACE_MS` before purging it, so it can still be restored.
 * Shared by thread Delete and "Delete workspace" with its conversations.
 */
export async function undoThreadDeletes(
  environmentId: EnvironmentId,
  threadIds: readonly ThreadId[],
): Promise<void> {
  const api = readEnvironmentApi(environmentId);
  if (!api) throw new Error("This environment is not connected.");
  await Promise.all(
    threadIds.map((threadId) =>
      api.orchestration.dispatchCommand({
        type: "thread.untrash",
        commandId: newCommandId(),
        threadId,
      }),
    ),
  );
}
