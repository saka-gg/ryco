import { useEffect, useRef, useState } from "react";
import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { readAttachmentBytesFromTransport } from "@ryco/client-runtime/rpc";
import { readEnvironmentApi } from "../../environmentApi";
import { attachmentUrlPolicy } from "./attachmentPreview";

export interface AttachmentContext {
  environmentId?: EnvironmentId | undefined;
  threadId?: ThreadId | undefined;
  messageId?: MessageId | undefined;
}

/**
 * Reads a thread message's attachment over its environment's authorized
 * attachment transport, as it stands when the read starts.
 */
export function readEnvironmentAttachmentBytes(input: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  messageId: MessageId;
  attachmentId: string;
  sizeBytes: number;
  signal?: AbortSignal;
}): Promise<Uint8Array<ArrayBuffer>> {
  const { environmentId, threadId, messageId, attachmentId } = input;
  return readAttachmentBytesFromTransport({
    reference: { threadId, messageId, attachmentId },
    sizeBytes: input.sizeBytes,
    ...(input.signal ? { signal: input.signal } : {}),
    currentTransport: () => readEnvironmentApi(environmentId)?.attachments,
  });
}

interface AttachmentSourceInput extends AttachmentContext {
  attachmentId?: string | undefined;
  sizeBytes?: number | undefined;
  mimeType?: string | undefined;
  /** Shown as an image, so an SVG must keep its type. */
  image?: boolean | undefined;
}

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)), { once: true });
    reader.addEventListener(
      "error",
      () => reject(reader.error ?? new Error("Unreadable attachment.")),
      { once: true },
    );
    reader.readAsDataURL(blob);
  });
}

function releaseUrl(url: string | undefined) {
  if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
}

/** One explicitly requested attachment per owner. The caller owns its mount lifetime. */
export function useAttachmentSource(input: AttachmentSourceInput) {
  const { environmentId, threadId, messageId, attachmentId, sizeBytes, mimeType } = input;
  const image = input.image === true;
  const identity = JSON.stringify([
    environmentId,
    threadId,
    messageId,
    attachmentId,
    sizeBytes,
    mimeType,
    image,
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
      releaseUrl(owned.url);
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
      const bytes = await readEnvironmentAttachmentBytes({
        environmentId,
        threadId,
        messageId,
        attachmentId,
        sizeBytes,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const policy = attachmentUrlPolicy({ mimeType, image });
      const blob = new Blob([bytes], { type: policy.type });
      const url = policy.scheme === "data" ? await readDataUrl(blob) : URL.createObjectURL(blob);
      if (controller.signal.aborted) {
        releaseUrl(url);
        return;
      }
      releaseUrl(owned.url);
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
