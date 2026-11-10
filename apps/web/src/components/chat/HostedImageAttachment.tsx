import { useEffect, useState } from "react";
import type { ChatImageAttachment } from "../../types";
import {
  loadHostedImage,
  peekHostedImage,
  type HostedImageReference,
  type HostedImageSource,
} from "./hostedImageSource";
import type { AttachmentLoadButton, AttachmentRender } from "./MessageAttachments";

/**
 * A thread image read over its machine's connection (Hub web): its preview
 * by itself, the original once it is opened or downloaded, both kept for the
 * session (`hostedImageSource`). Lazy, so a client reaching its nodes by URL
 * never loads it. The parent remounts it for another image.
 */
export default function HostedImageAttachment(props: {
  reference: HostedImageReference;
  attachment: ChatImageAttachment;
  button: AttachmentLoadButton;
  children: AttachmentRender;
}) {
  const { environmentId, threadId, messageId, attachmentId, sizeBytes, mimeType } = props.reference;
  const [state, setState] = useState<{
    source?: HostedImageSource | undefined;
    loading?: boolean;
    failed?: boolean;
  }>(() => ({ source: peekHostedImage(props.reference) }));
  const shown = state.source;
  useEffect(() => {
    if (shown) return;
    const controller = new AbortController();
    const reference = { environmentId, threadId, messageId, attachmentId, sizeBytes, mimeType };
    loadHostedImage(reference, false, controller.signal).then(
      (source) => {
        if (!source || controller.signal.aborted) return;
        setState((previous) => (previous.source ? previous : { source }));
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [shown, environmentId, threadId, messageId, attachmentId, sizeBytes, mimeType]);

  const loadOriginal = async () => {
    if (shown?.original) return shown.url;
    setState((previous) => ({ ...previous, loading: true, failed: false }));
    try {
      // Not stopped by an unmount: the original is kept for the session either way.
      const source = await loadHostedImage(props.reference, true, new AbortController().signal);
      setState(source ? { source } : (previous) => ({ ...previous, loading: false }));
      return source?.url;
    } catch {
      setState((previous) => ({ ...previous, loading: false, failed: true }));
      return undefined;
    }
  };
  if (!shown) {
    return props.button({
      loading: state.loading,
      failed: state.failed,
      load: () => void loadOriginal(),
    });
  }
  const attachment = { ...props.attachment, previewUrl: shown.url };
  return shown.original ? (
    props.children(attachment, true)
  ) : (
    <div
      aria-busy={state.loading || undefined}
      className={state.loading ? "animate-pulse" : undefined}
    >
      {props.children(attachment, false, loadOriginal)}
    </div>
  );
}
