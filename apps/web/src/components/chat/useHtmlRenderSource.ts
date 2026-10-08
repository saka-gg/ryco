import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { upgradeHtmlRenderBootstrap } from "@ryco/shared/htmlRender";
import { useCallback, useEffect, useEffectEvent, useState } from "react";

import { LRUCache } from "../../lib/lruCache";
import { useWsConnectionOpenedCount } from "../../rpc/wsConnectionState";
import { readEnvironmentAttachmentBytes } from "./useAttachmentSource";

/** Larger pages wait for the reader to ask; inlined images can make a page tens of MB. */
export const HTML_RENDER_AUTO_LOAD_MAX_BYTES = 8 * 1024 * 1024;

// Virtualized rows remount when they scroll back into view, and RPC reads have
// no HTTP cache, so decoded pages stay in memory (never in any persistent cache).
const SOURCE_CACHE_MAX_ENTRIES = 64;
const SOURCE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const sourceCache = new LRUCache<string>(SOURCE_CACHE_MAX_ENTRIES, SOURCE_CACHE_MAX_BYTES);
// A page above the auto-load cap is usually too large to keep decoded, so a
// remount reads it again; once the reader asked for it, it loads by itself.
const requestedSources = new LRUCache<true>(256, Number.POSITIVE_INFINITY);

interface HtmlRenderSourceReference {
  readonly environmentId: EnvironmentId | undefined;
  readonly threadId: ThreadId | undefined;
  readonly messageId: MessageId | undefined;
  readonly attachmentId: string;
}

function sourceKey(reference: HtmlRenderSourceReference): string | null {
  const { environmentId, threadId, messageId, attachmentId } = reference;
  return environmentId && threadId && messageId
    ? `${environmentId}:${threadId}:${messageId}:${attachmentId}`
    : null;
}

function rememberSource(key: string, html: string) {
  // Charged as UTF-16; one page never takes more than half the cache.
  const approximateBytes = html.length * 2;
  if (approximateBytes <= SOURCE_CACHE_MAX_BYTES / 2) sourceCache.set(key, html, approximateBytes);
}

export interface HtmlRenderSource {
  /**
   * The stored page, decoded, wearing this build's bootstrap (a page keeps
   * the one it was published with); undefined until it has loaded.
   */
  readonly html: string | undefined;
  readonly loading: boolean;
  readonly failed: boolean;
  /** Above the auto-load cap and not requested yet. */
  readonly deferred: boolean;
  /** Loads a deferred page, or retries a failed one. */
  readonly retry: () => void;
}

interface SourceState {
  readonly identity: string;
  readonly html?: string;
  readonly failed?: boolean;
  readonly requested?: boolean;
  /** The socket-open count when the failed read started; any later open retries it. */
  readonly failedAtOpenCount?: number;
}

// A page read before (this row scrolled away and back) shows without a load.
function initialSourceState(identity: string, key: string | null): SourceState {
  if (key === null) return { identity };
  const html = sourceCache.get(key);
  if (html !== null) return { identity, html };
  return requestedSources.get(key) === null ? { identity } : { identity, requested: true };
}

/**
 * An HTML render's stored page, read over the environment's authorized
 * attachment transport (local, remote and hosted alike) and decoded as UTF-8,
 * with its bootstrap upgraded to this build's so older pages get today's
 * bridge and theming. Loads on mount, aborts on unmount, and retries a failed
 * read once a socket opens again.
 */
export function useHtmlRenderSource(input: {
  readonly environmentId: EnvironmentId | undefined;
  readonly threadId: ThreadId | undefined;
  readonly messageId: MessageId | undefined;
  readonly attachment: { readonly id: string; readonly sizeBytes: number };
}): HtmlRenderSource {
  const { environmentId, threadId, messageId } = input;
  const { id: attachmentId, sizeBytes } = input.attachment;
  const key = sourceKey({ environmentId, threadId, messageId, attachmentId });
  const identity = `${key}:${sizeBytes}`;
  const [stored, setState] = useState<SourceState>(() => initialSourceState(identity, key));
  const state = stored.identity === identity ? stored : initialSourceState(identity, key);
  // Every socket open, from any environment. A read that failed while its
  // connection was down counts as pending again once one opens; a read in
  // flight is left alone (another environment's socket can keep reopening).
  const openCount = useWsConnectionOpenedCount();
  const readOpenCount = useEffectEvent(() => openCount);
  const failed = state.failed === true && state.failedAtOpenCount === openCount;
  const deferred =
    state.html === undefined &&
    !state.requested &&
    !failed &&
    sizeBytes > HTML_RENDER_AUTO_LOAD_MAX_BYTES;
  const loading = key !== null && state.html === undefined && !failed && !deferred;

  const { failedAtOpenCount } = state;
  // One read per attempt. A read whose own transport was replaced fails, but a
  // socket has opened since it started, so it is pending again straight away;
  // its new failure count is what starts the next read.
  useEffect(() => {
    if (!loading || key === null || !environmentId || !threadId || !messageId) return;
    const startedAtOpenCount = readOpenCount();
    const controller = new AbortController();
    void readEnvironmentAttachmentBytes({
      environmentId,
      threadId,
      messageId,
      attachmentId,
      sizeBytes,
      signal: controller.signal,
    }).then(
      (bytes) => {
        if (controller.signal.aborted) return;
        // Upgraded once per read; the cache keeps the upgraded page.
        const html = upgradeHtmlRenderBootstrap(
          new TextDecoder("utf-8", { fatal: false }).decode(bytes),
        );
        rememberSource(key, html);
        setState({ identity, html });
      },
      () => {
        if (controller.signal.aborted) return;
        setState({
          identity,
          failed: true,
          requested: true,
          failedAtOpenCount: startedAtOpenCount,
        });
      },
    );
    return () => controller.abort();
  }, [
    attachmentId,
    environmentId,
    // Not read inside: a new failure count is what starts the next attempt.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
    failedAtOpenCount,
    identity,
    key,
    loading,
    messageId,
    sizeBytes,
    threadId,
  ]);

  const retry = useCallback(() => {
    if (key !== null) requestedSources.set(key, true, 1);
    setState((previous) =>
      previous.identity === identity && previous.html !== undefined
        ? previous
        : { identity, requested: true },
    );
  }, [identity, key]);

  return { html: state.html, loading, failed, deferred, retry };
}

/** Seeds the decoded-page cache, as a completed read would. */
export function __rememberHtmlRenderSourceForTests(
  reference: HtmlRenderSourceReference,
  html: string,
): void {
  const key = sourceKey(reference);
  if (key !== null) rememberSource(key, html);
}

export function __resetHtmlRenderSourceCacheForTests(): void {
  sourceCache.clear();
  requestedSources.clear();
}
