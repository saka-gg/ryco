import type {
  EnvironmentId,
  OrchestrationGetThreadHistoryPageInput,
  OrchestrationThreadHistoryPage,
  ThreadId,
} from "@ryco/contracts";

import { LRUCache } from "../../lib/lruCache";
import { parseWorkspaceRenderKey, type WorkspaceRenderTarget } from "../../workspaceRouteSearch";
import { readHtmlRenderAttachment, type HtmlRenderAttachment } from "./htmlRender.logic";

/**
 * A page tab names its render by message and attachment. Usually that message
 * is in the thread as loaded; when it lies further back than the loaded window
 * (the tab restored after the thread reloaded, a link), the one message is
 * read on its own, beside the thread store and never merged into it: the
 * timeline's window, the history the reader scrolled back through and its
 * paging all stay exactly as they are. What the environment answers is
 * remembered, so a remount never asks again.
 */

export type ReadThreadHistoryPage = (
  environmentId: EnvironmentId,
  input: OrchestrationGetThreadHistoryPageInput,
) => Promise<OrchestrationThreadHistoryPage>;

/** The environment's answer: the render, or null when its message (or that render) is gone. */
export interface HtmlRenderLookupVerdict {
  readonly render: HtmlRenderAttachment | null;
}

const VERDICT_CACHE_MAX_ENTRIES = 64;

function lookupKey(environmentId: EnvironmentId, threadId: ThreadId, renderKey: string) {
  return `${environmentId}:${threadId}:${renderKey}`;
}

// The page tab never shows the thumbnails, which can run to tens of KB each.
function withoutThumbnails(render: HtmlRenderAttachment): HtmlRenderAttachment {
  const { thumbnails: _thumbnails, ...htmlRender } = render.htmlRender;
  const { htmlRender: _metadata, ...attachment } = render.attachment;
  return { attachment, htmlRender };
}

/** The environment's own answer that a message is not in the thread (any more). */
function isMessageGone(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { _tag, reason } = error as { readonly _tag?: unknown; readonly reason?: unknown };
  return (
    _tag === "OrchestrationThreadHistoryError" &&
    (reason === "stale-cursor" || reason === "thread-not-found")
  );
}

export function createHtmlRenderLookup(readPage: ReadThreadHistoryPage) {
  const verdicts = new LRUCache<HtmlRenderLookupVerdict>(
    VERDICT_CACHE_MAX_ENTRIES,
    Number.POSITIVE_INFINITY,
  );
  const inflight = new Map<string, Promise<HtmlRenderAttachment | null>>();

  async function read(
    environmentId: EnvironmentId,
    threadId: ThreadId,
    target: WorkspaceRenderTarget,
  ): Promise<HtmlRenderAttachment | null> {
    let page: OrchestrationThreadHistoryPage;
    try {
      // Around the message with nothing on either side: just the message.
      page = await readPage(environmentId, {
        threadId,
        collection: "messages",
        mode: { kind: "around", anchorId: target.messageId },
        limit: 1,
      });
    } catch (error) {
      // Anything but the environment saying so (no connection, a dropped
      // one, a timeout) leaves the question open.
      if (isMessageGone(error)) return null;
      throw error;
    }
    const message =
      page.collection === "messages"
        ? page.items.find((item) => item.id === target.messageId)
        : undefined;
    const attachment = message?.attachments?.find(
      (candidate) => candidate.id === target.attachmentId,
    );
    const render = attachment === undefined ? undefined : readHtmlRenderAttachment(attachment);
    return render === undefined ? null : withoutThumbnails(render);
  }

  return {
    /** What is already known about a page further back, without asking. */
    peek(
      environmentId: EnvironmentId,
      threadId: ThreadId,
      renderKey: string,
    ): HtmlRenderLookupVerdict | undefined {
      return verdicts.get(lookupKey(environmentId, threadId, renderKey)) ?? undefined;
    },
    /**
     * The render, or null when the environment no longer has it. Rejects
     * (never throws) when the question stays open, so it can be asked again.
     */
    lookUp(
      environmentId: EnvironmentId,
      threadId: ThreadId,
      renderKey: string,
    ): Promise<HtmlRenderAttachment | null> {
      const key = lookupKey(environmentId, threadId, renderKey);
      const known = verdicts.get(key);
      if (known !== null) return Promise.resolve(known.render);
      const existing = inflight.get(key);
      if (existing) return existing;
      const target = parseWorkspaceRenderKey(renderKey);
      if (target === null) return Promise.resolve(null);
      const request = read(environmentId, threadId, target)
        .then((render) => {
          verdicts.set(key, { render }, 1);
          return render;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, request);
      return request;
    },
    clear(): void {
      verdicts.clear();
      inflight.clear();
    },
  };
}

export type HtmlRenderLookup = ReturnType<typeof createHtmlRenderLookup>;
