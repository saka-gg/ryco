import { useEffect, useRef, useState } from "react";
import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { readAttachmentBytes } from "@ryco/client-runtime/rpc";
import { readEnvironmentApi } from "../../environmentApi";

export interface AttachmentContext {
  environmentId?: EnvironmentId | undefined;
  threadId?: ThreadId | undefined;
  messageId?: MessageId | undefined;
}

interface AttachmentSourceInput extends AttachmentContext {
  attachmentId?: string | undefined;
  sizeBytes?: number | undefined;
  mimeType?: string | undefined;
}

/** One explicitly requested attachment per owner. The caller owns its mount lifetime. */
export function useAttachmentSource(input: AttachmentSourceInput) {
  const { environmentId, threadId, messageId, attachmentId, sizeBytes, mimeType } = input;
  const identity = JSON.stringify([
    environmentId,
    threadId,
    messageId,
    attachmentId,
    sizeBytes,
    mimeType,
  ]);
  const [state, setState] = useState<{
    identity: string;
    source?: string;
    loading?: boolean;
    failed?: boolean;
  }>({ identity });
  const resources = useRef<{ identity: string; controller?: AbortController; url?: string }>({
    identity,
  });
  useEffect(() => {
    const owned: { identity: string; controller?: AbortController; url?: string } = { identity };
    resources.current = owned;
    return () => {
      owned.controller?.abort();
      if (owned.url) URL.revokeObjectURL(owned.url);
    };
  }, [identity]);

  const load = async () => {
    const owned = resources.current;
    if (owned.identity !== identity) return;
    if (owned.controller && !owned.controller.signal.aborted) return;
    if (!environmentId || !threadId || !messageId || !attachmentId || sizeBytes === undefined)
      return;
    const controller = new AbortController();
    owned.controller = controller;
    setState({ identity, loading: true });
    try {
      // Capture the authorized transport once. A replacement connection must
      // never contribute chunks to the previous attempt's buffer.
      const api = readEnvironmentApi(environmentId)?.attachments;
      if (!api) throw new Error("Attachment connection unavailable.");
      const bytes = await readAttachmentBytes({
        reference: { threadId, messageId, attachmentId },
        sizeBytes,
        signal: controller.signal,
        readChunk: (chunk) => {
          if (readEnvironmentApi(environmentId)?.attachments?.readChunk !== api.readChunk)
            throw new Error("Attachment connection changed.");
          return api.readChunk(chunk);
        },
      });
      if (controller.signal.aborted) return;
      if (readEnvironmentApi(environmentId)?.attachments?.readChunk !== api.readChunk)
        throw new Error("Attachment connection changed.");
      const url = URL.createObjectURL(
        new Blob([bytes], { type: mimeType ?? "application/octet-stream" }),
      );
      if (owned.url) URL.revokeObjectURL(owned.url);
      owned.url = url;
      setState({ identity, source: url });
    } catch {
      if (!controller.signal.aborted) setState({ identity, failed: true });
    } finally {
      controller.abort();
    }
  };
  return { ...(state.identity === identity ? state : { identity }), load };
}
