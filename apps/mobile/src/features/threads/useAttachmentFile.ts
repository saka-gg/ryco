import { useEffect, useState } from "react";

import { readEnvironmentApi } from "../../connection/environmentApi";
import { useWsConnectionStatusForEnvironment } from "../../rpc/wsConnectionState";
import {
  acquireAttachmentFile,
  attachmentFileKey,
  peekStoredAttachmentFile,
  type AttachmentFileReference,
} from "./attachmentFiles";

export type AttachmentFile =
  /** Waiting for the reader to ask (too large to load by itself), or no reference yet. */
  | { readonly status: "idle"; readonly load: () => void }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly uri: string }
  | { readonly status: "failed"; readonly retry: () => void };

/**
 * One attachment as a local file, read over its machine's own connection
 * (`attachmentFiles.ts`). It loads by itself when `auto` (a row showing an
 * image), else on `load`. A failed read tries again when the machine
 * reconnects, and on the reader's tap. `uri` short-cuts all of it: a message
 * this device is still sending shows its own local copy.
 */
export function useAttachmentFile(input: {
  readonly reference: AttachmentFileReference | null;
  readonly auto: boolean;
  readonly uri?: string | undefined;
}): AttachmentFile {
  const { reference } = input;
  const key = reference === null ? "" : attachmentFileKey(reference);
  const status = useWsConnectionStatusForEnvironment(
    // The hook needs an id; without a reference nothing is read.
    reference?.environmentId ?? ("" as AttachmentFileReference["environmentId"]),
  );
  // A new connection is a new chance for a read that failed while offline.
  const connection = status.phase === "connected" ? (status.connectedAt ?? "connected") : "";
  const [request, setRequest] = useState({ key, attempt: 0, asked: false });
  const current = request.key === key ? request : { key, attempt: 0, asked: false };
  const wanted = input.uri === undefined && reference !== null && (input.auto || current.asked);
  const generation = `${current.attempt}:${connection}`;
  const [loaded, setLoaded] = useState<{ readonly key: string; readonly uri: string }>();
  const [failure, setFailure] = useState<{ readonly key: string; readonly generation: string }>();
  const kept = loaded?.key === key ? loaded.uri : key ? peekStoredAttachmentFile(key) : undefined;

  const environmentId = reference?.environmentId;
  const threadId = reference?.threadId;
  const messageId = reference?.messageId;
  const attachmentId = reference?.attachmentId;
  const name = reference?.name;
  const sizeBytes = reference?.sizeBytes;
  useEffect(() => {
    if (
      !wanted ||
      kept !== undefined ||
      environmentId === undefined ||
      threadId === undefined ||
      messageId === undefined ||
      attachmentId === undefined ||
      name === undefined ||
      sizeBytes === undefined
    )
      return;
    const lease = acquireAttachmentFile({
      reference: { environmentId, threadId, messageId, attachmentId, name, sizeBytes },
      currentTransport: () => readEnvironmentApi(environmentId)?.attachments,
    });
    let active = true;
    lease.promise.then(
      (uri) => {
        if (active) setLoaded({ key, uri });
      },
      () => {
        if (active) setFailure({ key, generation });
      },
    );
    return () => {
      active = false;
      lease.release();
    };
  }, [
    attachmentId,
    environmentId,
    generation,
    key,
    kept,
    messageId,
    name,
    sizeBytes,
    threadId,
    wanted,
  ]);

  const ask = () => setRequest({ key, attempt: current.attempt + 1, asked: true });
  if (input.uri !== undefined) return { status: "ready", uri: input.uri };
  if (kept !== undefined) return { status: "ready", uri: kept };
  if (!wanted) return { status: "idle", load: ask };
  if (failure?.key === key && failure.generation === generation) {
    return { status: "failed", retry: ask };
  }
  return { status: "loading" };
}
