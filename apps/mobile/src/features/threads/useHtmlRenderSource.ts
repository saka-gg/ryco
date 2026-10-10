import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { useEffect, useState } from "react";

import { readEnvironmentApi } from "../../connection/environmentApi";
import { useWsConnectionStatusForEnvironment } from "../../rpc/wsConnectionState";
import {
  acquireHtmlRenderSource,
  HTML_RENDER_AUTO_LOAD_MAX_BYTES,
  htmlRenderSourceKey,
  readCachedHtmlRenderSource,
} from "./htmlRenderSource";

export type HtmlRenderSource =
  /** Too large to load without the reader asking. */
  | { readonly status: "idle"; readonly load: () => void }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly html: string }
  | { readonly status: "failed"; readonly retry: () => void };

/** The page a row shows. */
interface Held {
  readonly key: string;
  readonly html: string;
}

/** A read that failed, and the attempt and connection it failed under. */
interface Failure {
  readonly key: string;
  readonly generation: string;
}

/**
 * The text of one render's page, read over the environment's authorized
 * connection. A failed read retries by itself when the environment reconnects,
 * and on the reader's tap.
 *
 * Once a row has its page it keeps it for as long as it is mounted: the shared
 * cache only saves a read when a row mounts. A row whose page the cache has
 * evicted, or never kept (too large), therefore neither drops the page on a
 * re-render nor loses it to a disconnect, and a reconnect never reads a page
 * that is already on screen.
 */
export function useHtmlRenderSource(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly attachmentId: string;
  readonly sizeBytes: number;
  /**
   * The reader already asked for this page (they opened it full screen), so it
   * loads whatever its size, without a second tap.
   */
  readonly requested?: boolean;
}): HtmlRenderSource {
  const { environmentId, threadId, messageId, attachmentId, sizeBytes } = input;
  const key = htmlRenderSourceKey(environmentId, { threadId, messageId, attachmentId });
  const status = useWsConnectionStatusForEnvironment(environmentId);
  // A new connection is a new chance: a read that failed while offline, or that
  // the reconnect cut off, starts again.
  const connection = status.phase === "connected" ? (status.connectedAt ?? "connected") : "";
  const [request, setRequest] = useState({ key, attempt: 0, asked: false });
  const current = request.key === key ? request : { key, attempt: 0, asked: false };
  const wanted =
    current.asked || input.requested === true || sizeBytes <= HTML_RENDER_AUTO_LOAD_MAX_BYTES;
  const generation = `${current.attempt}:${connection}`;
  // A row that mounts with its page cached holds it from its first render.
  const [held, setHeld] = useState<Held | undefined>(() => {
    const cached = readCachedHtmlRenderSource(key);
    return cached === undefined ? undefined : { key, html: cached };
  });
  const [failure, setFailure] = useState<Failure>();
  // A row given another page takes it from the cache as it renders (React
  // renders again at once, before committing), so the page it shows is always
  // its own and the cache evicting it later changes nothing on screen.
  const cached = held?.key === key ? undefined : readCachedHtmlRenderSource(key);
  if (cached !== undefined) setHeld({ key, html: cached });
  const html = held?.key === key ? held.html : cached;
  const holding = html !== undefined;

  useEffect(() => {
    if (holding || !wanted) return;
    const lease = acquireHtmlRenderSource({
      key,
      reference: { threadId, messageId, attachmentId },
      sizeBytes,
      currentTransport: () => readEnvironmentApi(environmentId)?.attachments,
    });
    let active = true;
    lease.promise.then(
      (html) => {
        if (active) setHeld({ key, html });
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
    holding,
    key,
    messageId,
    sizeBytes,
    threadId,
    wanted,
  ]);

  const ask = () => setRequest({ key, attempt: current.attempt + 1, asked: true });
  if (html !== undefined) return { status: "ready", html };
  if (!wanted) return { status: "idle", load: ask };
  if (failure?.key === key && failure.generation === generation) {
    return { status: "failed", retry: ask };
  }
  return { status: "loading" };
}
