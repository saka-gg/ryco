import {
  EnvironmentId,
  MessageId,
  OrchestrationGetSnapshotError,
  OrchestrationThreadHistoryError,
  ThreadId,
  type OrchestrationThreadHistoryPage,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createHtmlRenderLookup, type ReadThreadHistoryPage } from "./htmlRenderLookup";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const THREAD_ID = ThreadId.make("thread-1");
const MESSAGE_ID = MessageId.make("render-message");
const RENDER_KEY = `${MESSAGE_ID}:thread-1-chart-html`;
const ATTACHMENT = {
  type: "file" as const,
  id: "thread-1-chart-html",
  name: "Chart.html",
  mimeType: "text/html",
  sizeBytes: 2048,
  htmlRender: {
    title: "Chart",
    height: 420,
    thumbnails: { dark: "data:image/webp;base64,AAAA" },
  },
};

function pageWith(attachments: ReadonlyArray<typeof ATTACHMENT | object>) {
  return {
    collection: "messages",
    snapshotSequence: 7,
    items: [
      {
        id: MESSAGE_ID,
        role: "assistant",
        text: " ",
        attachments,
        turnId: null,
        streaming: false,
        createdAt: "2026-09-04T12:00:03.000Z",
        updatedAt: "2026-09-04T12:00:03.000Z",
      },
    ],
    page: { oldestCursor: null, newestCursor: null, hasMoreBefore: true },
  } as unknown as OrchestrationThreadHistoryPage;
}

function historyError(reason: OrchestrationThreadHistoryError["reason"]) {
  return new OrchestrationThreadHistoryError({ reason, threadId: THREAD_ID });
}

describe("createHtmlRenderLookup", () => {
  it("reads just the page's message, and remembers the page", async () => {
    const readPage = vi.fn<ReadThreadHistoryPage>(async () => pageWith([ATTACHMENT]));
    const lookup = createHtmlRenderLookup(readPage);

    const render = await lookup.lookUp(ENVIRONMENT_ID, THREAD_ID, RENDER_KEY);
    expect(readPage).toHaveBeenCalledExactlyOnceWith(ENVIRONMENT_ID, {
      threadId: THREAD_ID,
      collection: "messages",
      mode: { kind: "around", anchorId: MESSAGE_ID },
      limit: 1,
    });
    // The page tab needs neither thumbnail.
    expect(render).toEqual({
      attachment: {
        type: "file",
        id: "thread-1-chart-html",
        name: "Chart.html",
        mimeType: "text/html",
        sizeBytes: 2048,
      },
      htmlRender: { title: "Chart", height: 420 },
    });

    expect(lookup.peek(ENVIRONMENT_ID, THREAD_ID, RENDER_KEY)).toEqual({ render });
    expect(await lookup.lookUp(ENVIRONMENT_ID, THREAD_ID, RENDER_KEY)).toBe(render);
    expect(readPage).toHaveBeenCalledTimes(1);
  });

  it("asks once for concurrent lookups of the same page", async () => {
    let answer!: (page: OrchestrationThreadHistoryPage) => void;
    const readPage = vi.fn<ReadThreadHistoryPage>(
      () => new Promise((resolve) => (answer = resolve)),
    );
    const lookup = createHtmlRenderLookup(readPage);
    const first = lookup.lookUp(ENVIRONMENT_ID, THREAD_ID, RENDER_KEY);
    const second = lookup.lookUp(ENVIRONMENT_ID, THREAD_ID, RENDER_KEY);
    expect(lookup.peek(ENVIRONMENT_ID, THREAD_ID, RENDER_KEY)).toBeUndefined();
    answer(pageWith([ATTACHMENT]));
    expect(await first).toEqual(await second);
    expect(readPage).toHaveBeenCalledTimes(1);
  });

  it("takes the environment's word that the page is gone, and remembers it", async () => {
    for (const reason of ["stale-cursor", "thread-not-found"] as const) {
      const readPage = vi.fn<ReadThreadHistoryPage>(async () => {
        throw historyError(reason);
      });
      const lookup = createHtmlRenderLookup(readPage);
      expect(await lookup.lookUp(ENVIRONMENT_ID, THREAD_ID, RENDER_KEY)).toBeNull();
      expect(await lookup.lookUp(ENVIRONMENT_ID, THREAD_ID, RENDER_KEY)).toBeNull();
      expect(lookup.peek(ENVIRONMENT_ID, THREAD_ID, RENDER_KEY)).toEqual({ render: null });
      expect(readPage).toHaveBeenCalledTimes(1);
    }
  });

  it("finds no page on a message that no longer carries that render", async () => {
    const lookup = createHtmlRenderLookup(async () =>
      pageWith([{ ...ATTACHMENT, mimeType: "text/plain" }]),
    );
    expect(await lookup.lookUp(ENVIRONMENT_ID, THREAD_ID, RENDER_KEY)).toBeNull();
    const elsewhere = createHtmlRenderLookup(async () => pageWith([]));
    expect(await elsewhere.lookUp(ENVIRONMENT_ID, THREAD_ID, RENDER_KEY)).toBeNull();
  });

  it("leaves the question open when the lookup fails without an answer", async () => {
    const failures: unknown[] = [
      new OrchestrationGetSnapshotError({ message: "database is locked" }),
      historyError("invalid-cursor"),
      new Error("socket closed"),
    ];
    for (const failure of failures) {
      const readPage = vi
        .fn<ReadThreadHistoryPage>()
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce(pageWith([ATTACHMENT]));
      const lookup = createHtmlRenderLookup(readPage);
      await expect(lookup.lookUp(ENVIRONMENT_ID, THREAD_ID, RENDER_KEY)).rejects.toBe(failure);
      expect(lookup.peek(ENVIRONMENT_ID, THREAD_ID, RENDER_KEY)).toBeUndefined();
      // Asked again, it finds the page.
      expect(await lookup.lookUp(ENVIRONMENT_ID, THREAD_ID, RENDER_KEY)).not.toBeNull();
      expect(readPage).toHaveBeenCalledTimes(2);
    }
  });

  it("rejects, never throws, when reading fails at once", async () => {
    const lookup = createHtmlRenderLookup(() => {
      throw new Error("No websocket client registered for environment-local.");
    });
    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = lookup.lookUp(ENVIRONMENT_ID, THREAD_ID, RENDER_KEY);
    }).not.toThrow();
    await expect(pending).rejects.toThrow("No websocket client registered");
  });

  it("never asks about a key that names no render", async () => {
    const readPage = vi.fn<ReadThreadHistoryPage>();
    const lookup = createHtmlRenderLookup(readPage);
    expect(await lookup.lookUp(ENVIRONMENT_ID, THREAD_ID, "no-attachment")).toBeNull();
    expect(readPage).not.toHaveBeenCalled();
  });
});
