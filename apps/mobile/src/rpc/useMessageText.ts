import { useAtomValue } from "@effect/atom-react";
import {
  readWholeMessageText,
  resolveMessageTextView,
  type MessageTextView,
} from "@ryco/client-runtime/state/session";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { useCallback, useEffect, useMemo } from "react";

import { messageTextQuery } from "./messageTextAtoms";

export interface MessageTextSource {
  readonly id: string;
  readonly text: string;
  readonly textPreview?: { readonly fullLength: number } | undefined;
}

export interface MessageText extends MessageTextView {
  readonly retry: () => void;
  /** The whole text, for copying: this message's own, the loaded one, or read now. */
  readonly readWholeText: () => Promise<string>;
}

/**
 * The text a message row shows. A very long message the thread window sent as
 * a preview (`textPreview`) shows its head until `wanted`, then its whole text
 * once read (`orchestration.getMessageText`). Idle (no request) for a whole
 * message, or a preview not asked for.
 */
export function useMessageText(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly message: MessageTextSource | null;
  readonly wanted: boolean;
}): MessageText {
  const { environmentId, threadId, message, wanted } = input;
  const id = message?.id ?? null;
  const text = message?.text ?? "";
  const fullLength = message?.textPreview?.fullLength ?? null;
  const messageId = wanted && fullLength !== null ? id : null;
  const cacheKey = messageTextQuery.keyOf({ environmentId, threadId, messageId });
  useEffect(
    () => messageTextQuery.watch({ environmentId, threadId, messageId }),
    [environmentId, threadId, messageId],
  );
  const state = useAtomValue(messageTextQuery.getAtom(cacheKey));
  const retry = useCallback(() => messageTextQuery.refresh(cacheKey), [cacheKey]);
  const readWholeText = useCallback(
    () =>
      id === null
        ? Promise.resolve(text)
        : readWholeMessageText(messageTextQuery, {
            environmentId,
            threadId,
            message: { id, text, ...(fullLength !== null ? { textPreview: { fullLength } } : {}) },
          }),
    [environmentId, threadId, id, text, fullLength],
  );
  const view = useMemo(
    () =>
      resolveMessageTextView(
        { text, ...(fullLength !== null ? { textPreview: { fullLength } } : {}) },
        cacheKey,
        state,
      ),
    [text, fullLength, cacheKey, state],
  );
  return useMemo(() => ({ ...view, retry, readWholeText }), [view, retry, readWholeText]);
}
