import type { ThreadDeviceAttachment, ThreadDeviceState } from "@ryco/contracts";

/**
 * The thread's attachments, from a server that reports several or one that
 * reports one. Its own module: the chat route reads it eagerly, and the rest of
 * the device picker loads only with the device panel.
 */
export function threadAttachments(
  state: ThreadDeviceState | null | undefined,
): readonly ThreadDeviceAttachment[] {
  if (!state) return [];
  if (state.attachments) return state.attachments;
  return state.attachedDeviceUdid
    ? [
        {
          udid: state.attachedDeviceUdid,
          source: "user",
          attachPhase: state.attachPhase ?? null,
          lastError: state.lastError,
        },
      ]
    : [];
}
