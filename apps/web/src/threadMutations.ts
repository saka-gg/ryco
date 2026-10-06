import type { ScopedThreadRef } from "@ryco/contracts";

import { readEnvironmentApi } from "./environmentApi";
import { newCommandId } from "./lib/utils";

/** Renames a conversation. Rejects with the reason when it cannot. */
export async function renameThread(target: ScopedThreadRef, title: string): Promise<void> {
  const api = readEnvironmentApi(target.environmentId);
  if (!api) throw new Error("This device is not connected.");
  await api.orchestration.dispatchCommand({
    type: "thread.meta.update",
    commandId: newCommandId(),
    threadId: target.threadId,
    title,
  });
}
