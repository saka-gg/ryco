import {
  MessageId,
  OrchestrationThreadHistoryCursor,
  ThreadId,
  type OrchestrationThreadHistoryPage,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  ARTIFACT_HISTORY_PAGE_LIMIT,
  readEarlierArtifactMessages,
  type ReadArtifactHistoryPage,
} from "./earlierThreadArtifacts";

const THREAD_ID = ThreadId.make("thread-1");
const START = OrchestrationThreadHistoryCursor.make("v1.start");
const cursor = (name: string) => OrchestrationThreadHistoryCursor.make(`v1.${name}`);

function message(id: string, input: { role?: "user" | "assistant"; attachment?: boolean } = {}) {
  return {
    id: MessageId.make(id),
    role: input.role ?? "assistant",
    text: "",
    ...(input.attachment === false
      ? {}
      : {
          attachments: [
            { type: "file", id: `${id}-file`, name: "out.csv", mimeType: "text/csv", sizeBytes: 4 },
          ],
        }),
    turnId: null,
    streaming: false,
    createdAt: "2026-10-16T12:00:00.000Z",
    updatedAt: "2026-10-16T12:00:00.000Z",
  };
}

function page(
  items: ReadonlyArray<ReturnType<typeof message>>,
  next: OrchestrationThreadHistoryCursor | null,
): OrchestrationThreadHistoryPage {
  return {
    collection: "messages",
    snapshotSequence: 1,
    items,
    page: { oldestCursor: next, newestCursor: null, hasMoreBefore: next !== null },
  } as unknown as OrchestrationThreadHistoryPage;
}

describe("readEarlierArtifactMessages", () => {
  it("asks for one page of artifact messages before the cursor", async () => {
    const readPage = vi.fn<ReadArtifactHistoryPage>(async () =>
      page([message("m1"), message("m2")], cursor("m1")),
    );
    const read = await readEarlierArtifactMessages(readPage, THREAD_ID, START);
    expect(readPage).toHaveBeenCalledExactlyOnceWith({
      threadId: THREAD_ID,
      collection: "messages",
      mode: { kind: "before", cursor: START },
      limit: ARTIFACT_HISTORY_PAGE_LIMIT,
      messageFilter: "artifacts",
    });
    expect(read.messages.map((item) => item.id)).toEqual(["m1", "m2"]);
    expect(read.cursor).toBe(cursor("m1"));
  });

  it("narrows an older environment's unfiltered pages, reading on past ones without artifacts", async () => {
    const pages = [
      page([message("m9", { attachment: false }), message("m8", { role: "user" })], cursor("p2")),
      page([message("m7"), message("m6", { attachment: false })], cursor("p3")),
    ];
    const readPage = vi.fn<ReadArtifactHistoryPage>(async () => pages.shift()!);
    const read = await readEarlierArtifactMessages(readPage, THREAD_ID, START);
    expect(readPage).toHaveBeenCalledTimes(2);
    expect(readPage.mock.calls[1]?.[0]).toMatchObject({
      mode: { kind: "before", cursor: cursor("p2") },
    });
    expect(read.messages.map((item) => item.id)).toEqual(["m7"]);
    expect(read.cursor).toBe(cursor("p3"));
  });

  it("stops at the start of the thread, and after a bounded number of empty pages", async () => {
    const atStart = await readEarlierArtifactMessages(
      async () => page([message("m1", { attachment: false })], null),
      THREAD_ID,
      START,
    );
    expect(atStart).toEqual({ messages: [], cursor: null });

    const empty = vi.fn<ReadArtifactHistoryPage>(async () =>
      page([message("m1", { attachment: false })], cursor("more")),
    );
    const bounded = await readEarlierArtifactMessages(empty, THREAD_ID, START);
    expect(empty).toHaveBeenCalledTimes(5);
    expect(bounded).toEqual({ messages: [], cursor: cursor("more") });
  });
});
