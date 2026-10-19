import { MessageId, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./types.ts";
import {
  THREAD_CONTENT_CACHE_DECODE_MAX_CONTENT_ENTRIES,
  THREAD_CONTENT_CACHE_MAX_THREADS,
  createThreadContentCapture,
  decodeCachedEnvironmentContent,
  measureRecordBodyBytes,
  selectThreadsForContentCache,
  trimContentToBudget,
  utf8ByteLength,
  type ThreadContentSource,
} from "./threadContentCachePolicy.ts";

const threadId = (name: string) => ThreadId.make(name);
const message = (name: string, text = `text of ${name}`): ChatMessage => ({
  id: MessageId.make(name),
  role: "assistant",
  text,
  createdAt: "2026-10-01T00:00:00Z",
  streaming: false,
});

function sourceOf(threads: Record<string, ReadonlyArray<ChatMessage>>): ThreadContentSource {
  const messageIdsByThreadId: ThreadContentSource["messageIdsByThreadId"] = {};
  const messageByThreadId: ThreadContentSource["messageByThreadId"] = {};
  for (const [name, messages] of Object.entries(threads)) {
    messageIdsByThreadId[threadId(name)] = messages.map((entry) => entry.id);
    messageByThreadId[threadId(name)] = Object.fromEntries(
      messages.map((entry) => [entry.id, entry]),
    );
  }
  return { messageIdsByThreadId, messageByThreadId };
}

describe("selecting threads for the content cache", () => {
  const select = (
    threadIds: ReadonlyArray<string>,
    options: {
      readonly routed?: string | null;
      readonly visits?: Readonly<Record<string, string>>;
      readonly empty?: ReadonlyArray<string>;
    } = {},
  ) =>
    selectThreadsForContentCache({
      threadIds,
      hasMessages: (id) => !options.empty?.includes(id),
      routedThreadId: options.routed ?? null,
      lastVisitedAt: (id) => options.visits?.[id],
    });

  it("lists the least recently visited first and a never-visited thread before any visit", () => {
    expect(
      select(["recent", "never", "oldest"], {
        visits: { recent: "2026-10-03T00:00:00Z", oldest: "2026-10-01T00:00:00Z" },
      }),
    ).toEqual(["never", "oldest", "recent"]);
  });

  it("keeps the routed thread last however long ago it was visited", () => {
    expect(
      select(["a", "b", "c"], {
        routed: "a",
        visits: {
          a: "2026-10-01T00:00:00Z",
          b: "2026-10-02T00:00:00Z",
          c: "2026-10-03T00:00:00Z",
        },
      }),
    ).toEqual(["b", "c", "a"]);
  });

  it("ignores a routed thread that is not one of the candidates", () => {
    expect(select(["a", "b"], { routed: "elsewhere" })).toEqual(["a", "b"]);
  });

  it("leaves out threads without messages and keeps the order of equal visits", () => {
    expect(select(["a", "empty", "b", "c"], { empty: ["empty"] })).toEqual(["a", "b", "c"]);
  });

  it("keeps the most recent threads, and the routed one, when there are more than the limit", () => {
    const ids = Array.from({ length: THREAD_CONTENT_CACHE_MAX_THREADS + 8 }, (_, i) => `t${i}`);
    const visits = Object.fromEntries(
      ids.map((id, i) => [id, `2026-10-01T00:${String(i).padStart(2, "0")}:00Z`]),
    );
    const selected = select(ids, { routed: "t0", visits });
    expect(selected).toHaveLength(THREAD_CONTENT_CACHE_MAX_THREADS);
    expect(selected.at(-1)).toBe("t0");
    expect(selected[0]).toBe("t9");
    expect(selected).not.toContain("t8");
  });
});

describe("capturing thread content for a record", () => {
  it("measures each entry as its serialized `id:content` pair in UTF-8", () => {
    const capture = createThreadContentCapture();
    const source = sourceOf({ plain: [message("m1")], wide: [message("m2", "naïve 😀 日本語")] });
    const captured = capture.capture("env", source, [threadId("plain"), threadId("wide")]);
    expect(captured.map((entry) => entry.threadId)).toEqual(["plain", "wide"]);
    for (const entry of captured) {
      const serialized = JSON.stringify({ [entry.threadId]: entry.content }).slice(1, -1);
      expect(entry.entryBytes).toBe(utf8ByteLength(serialized));
    }
    // Multi-byte text is longer in UTF-8 than in UTF-16 code units.
    const wide = captured[1]!;
    expect(wide.entryBytes).toBeGreaterThan(JSON.stringify({ wide: wide.content }).length - 2);
  });

  it("captures only an allowlist of message fields, never streaming state", () => {
    const capture = createThreadContentCapture();
    const source = sourceOf({
      live: [{ ...message("m1"), streaming: true, attachments: [{ id: "a" }] } as ChatMessage],
    });
    const [entry] = capture.capture("env", source, [threadId("live")]);
    expect(entry!.content.messages[0]).toMatchObject({ id: "m1", streaming: false });
    expect(entry!.content.messages[0]).not.toHaveProperty("attachments");
  });

  it("re-captures only threads whose message list changed", () => {
    const capture = createThreadContentCapture();
    const first = sourceOf({ a: [message("a1")], b: [message("b1")] });
    const ids = [threadId("a"), threadId("b")];
    const before = capture.capture("env", first, ids);

    // A new state that shares thread a's message objects but replaces b's.
    const next: ThreadContentSource = {
      messageIdsByThreadId: {
        ...first.messageIdsByThreadId,
        [threadId("b")]: [MessageId.make("b1"), MessageId.make("b2")],
      },
      messageByThreadId: {
        ...first.messageByThreadId,
        [threadId("b")]: {
          ...first.messageByThreadId[threadId("b")],
          [MessageId.make("b2")]: message("b2"),
        },
      },
    };
    const after = capture.capture("env", next, ids);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[1]!.content.messages.map((entry) => entry.id)).toEqual(["b1", "b2"]);

    // The same inputs again reuse both.
    const again = capture.capture("env", next, ids);
    expect(again[0]).toBe(after[0]);
    expect(again[1]).toBe(after[1]);
  });

  it("keeps each environment's captures apart and drops them on forget and clear", () => {
    const capture = createThreadContentCapture();
    const source = sourceOf({ a: [message("a1")] });
    const ids = [threadId("a")];
    const one = capture.capture("one", source, ids)[0];
    const two = capture.capture("two", source, ids)[0];
    expect(two).not.toBe(one);
    expect(capture.capture("one", source, ids)[0]).toBe(one);

    capture.forget("one");
    expect(capture.capture("one", source, ids)[0]).not.toBe(one);
    expect(capture.capture("two", source, ids)[0]).toBe(two);

    capture.clear();
    expect(capture.capture("two", source, ids)[0]).not.toBe(two);
  });

  it("forgets a thread that is no longer saved", () => {
    const capture = createThreadContentCapture();
    const source = sourceOf({ a: [message("a1")], b: [message("b1")] });
    const [a] = capture.capture("env", source, [threadId("a"), threadId("b")]);
    capture.capture("env", source, [threadId("b")]);
    expect(capture.capture("env", source, [threadId("a")])[0]).not.toBe(a);
  });

  it("captures a thread with no loaded message map as empty content", () => {
    const capture = createThreadContentCapture();
    const source: ThreadContentSource = {
      messageIdsByThreadId: { [threadId("a")]: [MessageId.make("gone")] },
      messageByThreadId: {},
    };
    expect(capture.capture("env", source, [threadId("a")])[0]!.content.messages).toEqual([]);
  });
});

describe("trimming content to a record budget", () => {
  const entry = (name: string, text: string) => {
    const content = { messages: [message(name, text)] };
    return {
      id: name,
      content,
      entryBytes:
        utf8ByteLength(JSON.stringify(name)) + 1 + utf8ByteLength(JSON.stringify(content)),
    };
  };
  const body = { metadata: { title: "Workspace" }, drafts: { k: "typed" }, scroll: { k: 12 } };
  const serializedBytes = (entries: ReadonlyArray<ReturnType<typeof entry>>) =>
    utf8ByteLength(
      JSON.stringify({
        ...body,
        content: Object.fromEntries(entries.map((item) => [item.id, item.content])),
      }),
    );
  const entries = [
    entry("a", "x".repeat(300)),
    entry("b", "é".repeat(200)),
    entry("c", "z".repeat(100)),
  ];

  it("measures a record exactly as it serializes", () => {
    const bodyBytes = measureRecordBodyBytes(body);
    for (const count of [0, 1, 2, 3]) {
      const kept = entries.slice(0, count);
      const contentBytes =
        2 + kept.reduce((total, item) => total + item.entryBytes, 0) + Math.max(0, count - 1);
      expect(bodyBytes + contentBytes).toBe(serializedBytes(kept));
    }
  });

  it("keeps everything that fits, up to a record exactly at the budget", () => {
    const bodyBytes = measureRecordBodyBytes(body);
    expect(
      trimContentToBudget({ bodyBytes, entries, budgetBytes: serializedBytes(entries) }),
    ).toEqual(entries);
  });

  it("drops from the front, one thread at a time, until the record fits", () => {
    const bodyBytes = measureRecordBodyBytes(body);
    const fullBytes = serializedBytes(entries);
    expect(trimContentToBudget({ bodyBytes, entries, budgetBytes: fullBytes - 1 })).toEqual(
      entries.slice(1),
    );
    const withoutFirst = serializedBytes(entries.slice(1));
    expect(trimContentToBudget({ bodyBytes, entries, budgetBytes: withoutFirst })).toEqual(
      entries.slice(1),
    );
    expect(trimContentToBudget({ bodyBytes, entries, budgetBytes: withoutFirst - 1 })).toEqual(
      entries.slice(2),
    );
  });

  it("drops every thread when even an empty record is over budget", () => {
    const bodyBytes = measureRecordBodyBytes(body);
    expect(trimContentToBudget({ bodyBytes, entries, budgetBytes: 0 })).toEqual([]);
    expect(trimContentToBudget({ bodyBytes, entries: [], budgetBytes: 0 })).toEqual([]);
  });
});

describe("decoding saved environment content", () => {
  const saved = (name: string) => ({ messages: [message(name)] });

  it("keeps valid content for threads the record lists", () => {
    const decoded = decodeCachedEnvironmentContent(
      JSON.parse(JSON.stringify({ content: { a: saved("a1"), b: saved("b1") } })),
      new Set(["a", "b"]),
    );
    expect(Object.keys(decoded)).toEqual(["a", "b"]);
    expect(decoded.a!.messages[0]).toMatchObject({ id: "a1", streaming: false });
  });

  it("drops content for unknown threads and content that fails its limits", () => {
    const decoded = decodeCachedEnvironmentContent(
      {
        content: {
          known: saved("k1"),
          unknown: saved("u1"),
          duplicate: { messages: [message("d1"), message("d1")] },
          oversized: { messages: [message("o1", "x".repeat(1_000_001))] },
          malformed: "not content",
        },
      },
      new Set(["known", "duplicate", "oversized", "malformed"]),
    );
    expect(Object.keys(decoded)).toEqual(["known"]);
  });

  it("reads at most the entry limit", () => {
    const names = Array.from(
      { length: THREAD_CONTENT_CACHE_DECODE_MAX_CONTENT_ENTRIES + 5 },
      (_, i) => `t${i}`,
    );
    const decoded = decodeCachedEnvironmentContent(
      { content: Object.fromEntries(names.map((name) => [name, saved(`${name}-m`)])) },
      new Set(names),
    );
    expect(Object.keys(decoded)).toEqual(
      names.slice(0, THREAD_CONTENT_CACHE_DECODE_MAX_CONTENT_ENTRIES),
    );
  });

  it("returns nothing for a record without usable content", () => {
    for (const record of [{}, { content: null }, { content: 7 }, { content: "text" }]) {
      expect(decodeCachedEnvironmentContent(record, new Set(["a"]))).toEqual({});
    }
  });
});
