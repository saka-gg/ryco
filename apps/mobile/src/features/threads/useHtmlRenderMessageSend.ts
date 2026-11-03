import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { useMemo } from "react";

import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { newCommandId, newMessageId } from "../../lib/ids";
import { enqueueThreadOutboxMessage } from "../../state/threadOutbox";
import { runOutboxDrain } from "../../state/use-thread-outbox-drain";
import { buildHtmlRenderOutboxMessage, createHtmlRenderMessageDelivery } from "./htmlRenderMessage";

/** Queues a page's confirmed message in the thread's outbox and starts the drain. */
function queueHtmlRenderMessage(environmentId: EnvironmentId, threadId: ThreadId, text: string) {
  enqueueThreadOutboxMessage(
    buildHtmlRenderOutboxMessage({
      environmentId,
      threadId,
      messageId: newMessageId(),
      commandId: newCommandId(),
      text,
      createdAt: new Date().toISOString(),
    }),
  );
  runOutboxDrain();
}

/**
 * The `onSendMessage` of a page in its thread: a native confirmation, then the
 * thread's outbox. Undefined unless `enabled` (a page the thread's own agent
 * published, `canHtmlRenderSendFromMessage`).
 */
export function useHtmlRenderMessageSend(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly enabled: boolean;
}): ((text: string) => Promise<void>) | undefined {
  const { enabled, environmentId, threadId, title } = input;
  return useMemo(
    () =>
      enabled
        ? createHtmlRenderMessageDelivery({
            pageTitle: title,
            confirm: showConfirmDialog,
            queue: (text) => queueHtmlRenderMessage(environmentId, threadId, text),
          })
        : undefined,
    [enabled, environmentId, threadId, title],
  );
}
