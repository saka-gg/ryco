import {
  readAttachmentBytesFromTransport,
  type AttachmentReadTransport,
} from "@ryco/client-runtime/rpc";
import type { ChatAttachmentReadChunkInput } from "@ryco/contracts";
import { upgradeHtmlRenderBootstrap } from "@ryco/shared/htmlRender";
import { LRUCache } from "@ryco/shared/lruCache";

// An HTML render's page reaches mobile over the authorized attachment chunk
// RPC, never a URL: the attachment route serves HTML as a download, and the
// app's credentials must not enter a WebView. Decoded pages are kept in a small
// cache because the feed unmounts rows that scroll away, and reading a page
// again on every scroll back would cost the reader's data. A page keeps the
// bootstrap it was published with, so an older build's is swapped for this
// build's as the page is read, and the cache keeps the upgraded page.

/**
 * Pages up to this size load as their row mounts. A larger page (inlined
 * screenshots) waits for a tap, so scrolling a thread never pulls tens of
 * megabytes over a phone connection.
 */
export const HTML_RENDER_AUTO_LOAD_MAX_BYTES = 4 * 1024 * 1024;

// JS strings cost two bytes per UTF-16 unit. A page bigger than half the
// budget is shown but not kept, so one page cannot evict every other.
const CACHE_MAX_ENTRIES = 32;
const CACHE_MAX_BYTES = 24 * 1024 * 1024;
const cache = new LRUCache<string>(CACHE_MAX_ENTRIES, CACHE_MAX_BYTES);

export type HtmlRenderAttachmentReference = Omit<ChatAttachmentReadChunkInput, "offset">;

export function htmlRenderSourceKey(
  environmentId: string,
  reference: HtmlRenderAttachmentReference,
): string {
  return JSON.stringify([
    environmentId,
    reference.threadId,
    reference.messageId,
    reference.attachmentId,
  ]);
}

export function readCachedHtmlRenderSource(key: string): string | undefined {
  return cache.get(key) ?? undefined;
}

function rememberHtmlRenderSource(key: string, html: string) {
  const size = html.length * 2;
  if (size <= CACHE_MAX_BYTES / 2) cache.set(key, html, size);
}

/** For tests: forget every cached page. */
export function clearHtmlRenderSourceCache() {
  cache.clear();
}

/** A page is text; malformed bytes become replacement characters rather than a failed load. */
export function decodeHtmlRenderBytes(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

interface InflightRead {
  readonly controller: AbortController;
  readonly promise: Promise<string>;
  holders: number;
}

const inflight = new Map<string, InflightRead>();

export interface HtmlRenderSourceRequest {
  /** `htmlRenderSourceKey` of the environment and reference. */
  readonly key: string;
  readonly reference: HtmlRenderAttachmentReference;
  readonly sizeBytes: number;
  /** The environment's authorized transport right now; undefined while disconnected. */
  readonly currentTransport: () => AttachmentReadTransport | undefined;
}

export interface HtmlRenderSourceLease {
  readonly promise: Promise<string>;
  /** The caller no longer needs the page. The read stops once no caller does. */
  readonly release: () => void;
}

/**
 * The page's text: from the cache, or from one read shared by every row that
 * asks for the same page while it is in flight. The read is aborted once every
 * holder has released it, so a row scrolled away does not keep downloading.
 */
export function acquireHtmlRenderSource(request: HtmlRenderSourceRequest): HtmlRenderSourceLease {
  const { key } = request;
  const cached = readCachedHtmlRenderSource(key);
  if (cached !== undefined) return { promise: Promise.resolve(cached), release: () => undefined };
  let read = inflight.get(key);
  if (read === undefined) {
    const controller = new AbortController();
    const promise = readAttachmentBytesFromTransport({
      reference: request.reference,
      sizeBytes: request.sizeBytes,
      signal: controller.signal,
      currentTransport: request.currentTransport,
    }).then((bytes) => {
      const html = upgradeHtmlRenderBootstrap(decodeHtmlRenderBytes(bytes));
      rememberHtmlRenderSource(key, html);
      return html;
    });
    const started: InflightRead = { controller, promise, holders: 0 };
    const settle = () => {
      if (inflight.get(key) === started) inflight.delete(key);
    };
    // Also handles the rejection of a read nobody awaits anymore.
    promise.then(settle, settle);
    inflight.set(key, started);
    read = started;
  }
  const held = read;
  held.holders += 1;
  let released = false;
  return {
    promise: held.promise,
    release: () => {
      if (released) return;
      released = true;
      held.holders -= 1;
      if (held.holders > 0) return;
      held.controller.abort();
      if (inflight.get(key) === held) inflight.delete(key);
    },
  };
}
