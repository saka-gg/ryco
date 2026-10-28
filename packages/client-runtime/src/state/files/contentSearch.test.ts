import {
  ProjectSearchContentError,
  ProjectSearchContentInput,
  type ProjectContentMatch,
  type ProjectSearchContentResult,
  type ServerConfig,
} from "@ryco/contracts";
import { Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CONTENT_SEARCH_DEBOUNCE_MS,
  CONTENT_SEARCH_PAGE_LIMIT,
  CONTENT_SEARCH_QUERY_MAX_LENGTH,
  createWorkspaceContentSearch,
  groupContentSearchMatches,
  normalizeContentSearchQuery,
  selectProjectContentSearchSupported,
} from "./contentSearch.ts";

const CWD = "/repo";

function match(path: string, lineNumber = 1): ProjectContentMatch {
  return { path, lineNumber, preview: `line ${lineNumber}`, ranges: [{ start: 0, end: 4 }] };
}

const searchFailed = (reason: "cursor" | "failed", message: string) =>
  new ProjectSearchContentError({ reason, message });

interface SentSearch {
  readonly request: ProjectSearchContentInput;
  readonly signal: AbortSignal;
  readonly resolve: (result: ProjectSearchContentResult) => void;
  readonly reject: (error: unknown) => void;
}

function harness(
  input: Omit<Parameters<typeof createWorkspaceContentSearch>[0], "cwd" | "search"> = {},
) {
  const sent: SentSearch[] = [];
  const search = createWorkspaceContentSearch({
    cwd: CWD,
    search: (request, { signal }) =>
      new Promise((resolve, reject) => sent.push({ request, signal, resolve, reject })),
    ...input,
  });
  const listener = vi.fn();
  search.subscribe(listener);
  return { search, sent, listener, snapshot: () => search.getSnapshot() };
}

/** Lets the request chain's promise hops run. */
const settle = () => vi.advanceTimersByTimeAsync(0);

/** Types `raw` and waits out the debounce until its first page is sent. */
async function type(search: ReturnType<typeof harness>["search"], raw: string) {
  search.setQuery(raw);
  await vi.advanceTimersByTimeAsync(CONTENT_SEARCH_DEBOUNCE_MS);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("normalizeContentSearchQuery", () => {
  it("keeps whitespace, which is part of what is searched", () => {
    expect(normalizeContentSearchQuery("  ab ")).toBe("  ab ");
    expect(normalizeContentSearchQuery("a b")).toBe("a b");
  });

  it("searches nothing for short, whitespace-only or multi-line input", () => {
    expect(normalizeContentSearchQuery("")).toBe("");
    expect(normalizeContentSearchQuery("a")).toBe("");
    expect(normalizeContentSearchQuery("   ")).toBe("");
    expect(normalizeContentSearchQuery("ab\ncd")).toBe("");
    expect(normalizeContentSearchQuery("ab\r")).toBe("");
    expect(normalizeContentSearchQuery("ab\0")).toBe("");
  });

  it("cuts long input to a query the contract accepts, never splitting a surrogate pair", () => {
    const long = normalizeContentSearchQuery("a".repeat(CONTENT_SEARCH_QUERY_MAX_LENGTH + 10));
    expect(long).toHaveLength(CONTENT_SEARCH_QUERY_MAX_LENGTH);
    expect(() =>
      Schema.decodeUnknownSync(ProjectSearchContentInput)({
        cwd: CWD,
        query: long,
        limit: CONTENT_SEARCH_PAGE_LIMIT,
      }),
    ).not.toThrow();

    const emoji = "\u{1F600}";
    const straddling = `${"a".repeat(CONTENT_SEARCH_QUERY_MAX_LENGTH - 1)}${emoji}`;
    expect(normalizeContentSearchQuery(straddling)).toBe(
      "a".repeat(CONTENT_SEARCH_QUERY_MAX_LENGTH - 1),
    );
  });
});

describe("groupContentSearchMatches", () => {
  it("groups each file's matches under its name and parent, in the node's order", () => {
    const groups = groupContentSearchMatches([
      match("src/a.ts", 1),
      match("src/a.ts", 7),
      match("README.md", 2),
    ]);
    expect(groups).toEqual([
      {
        path: "src/a.ts",
        name: "a.ts",
        parentPath: "src",
        matches: [match("src/a.ts", 1), match("src/a.ts", 7)],
      },
      { path: "README.md", name: "README.md", parentPath: null, matches: [match("README.md", 2)] },
    ]);
  });

  it("keeps one group per file when a malformed payload repeats a file", () => {
    const groups = groupContentSearchMatches([match("a.ts", 1), match("b.ts"), match("a.ts", 3)]);
    expect(groups.map((group) => [group.path, group.matches.length])).toEqual([
      ["a.ts", 2],
      ["b.ts", 1],
    ]);
  });
});

describe("selectProjectContentSearchSupported", () => {
  it("is true only when the node advertises the capability", () => {
    const withCapability = (projectContentSearch: boolean | undefined) =>
      ({ environment: { capabilities: { projectContentSearch } } }) as unknown as ServerConfig;
    expect(selectProjectContentSearchSupported(null)).toBe(false);
    expect(selectProjectContentSearchSupported(withCapability(undefined))).toBe(false);
    expect(selectProjectContentSearchSupported(withCapability(false))).toBe(false);
    expect(selectProjectContentSearchSupported(withCapability(true))).toBe(true);
  });
});

describe("createWorkspaceContentSearch", () => {
  it("searches the typed query once typing pauses", async () => {
    const { search, sent, snapshot } = harness();
    search.setQuery("ab");
    expect(snapshot()).toMatchObject({ query: "ab", status: "searching" });
    await vi.advanceTimersByTimeAsync(CONTENT_SEARCH_DEBOUNCE_MS - 1);
    expect(sent).toHaveLength(0);

    search.setQuery("abc");
    await vi.advanceTimersByTimeAsync(CONTENT_SEARCH_DEBOUNCE_MS - 1);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent.map((entry) => entry.request)).toEqual([
      { cwd: CWD, query: "abc", limit: CONTENT_SEARCH_PAGE_LIMIT },
    ]);

    sent[0]!.resolve({ matches: [match("a.ts")] });
    await settle();
    expect(snapshot()).toMatchObject({
      status: "ready",
      matches: [match("a.ts")],
      hasMore: false,
      error: null,
    });
  });

  it("never sends empty, whitespace-only or too-short input", async () => {
    const { search, sent, snapshot, listener } = harness();
    search.setQuery("a");
    expect(snapshot()).toMatchObject({ query: "", status: "tooShort" });
    search.setQuery("   ");
    expect(snapshot().status).toBe("idle");
    search.setQuery("");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toHaveLength(0);
    // Unchanged input publishes nothing.
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("aborts the request a new query supersedes and ignores its late answer", async () => {
    const { search, sent, snapshot } = harness();
    await type(search, "ab");
    sent[0]!.resolve({ matches: [match("a.ts")] });
    await settle();

    await type(search, "abc");
    search.setQuery("abcd");
    expect(sent[1]!.signal.aborted).toBe(true);
    sent[1]!.resolve({ matches: [match("stale.ts")] });
    await settle();
    // The previous search's matches stay until the new first page replaces them.
    expect(snapshot()).toMatchObject({ query: "abcd", status: "searching" });
    expect(snapshot().matches).toEqual([match("a.ts")]);

    await vi.advanceTimersByTimeAsync(CONTENT_SEARCH_DEBOUNCE_MS);
    sent[2]!.resolve({ matches: [match("b.ts")] });
    await settle();
    expect(sent[2]!.request.query).toBe("abcd");
    expect(snapshot()).toMatchObject({ status: "ready", matches: [match("b.ts")] });
  });

  it("clears the results when the input stops being a query", async () => {
    const { search, sent, snapshot } = harness();
    await type(search, "ab");
    search.setQuery("a");
    expect(sent[0]!.signal.aborted).toBe(true);
    expect(snapshot()).toMatchObject({ status: "tooShort", matches: [] });
  });

  it("searches again at once when an option changes, sending only enabled options", async () => {
    const { search, sent, snapshot } = harness();
    search.setOptions({ wholeWord: true });
    expect(snapshot().options).toEqual({ caseSensitive: false, wholeWord: true });
    await settle();
    expect(sent).toHaveLength(0);

    await type(search, "ab");
    sent[0]!.resolve({ matches: [] });
    await settle();
    search.setOptions({ wholeWord: true });
    search.setOptions({ caseSensitive: true });
    await settle();
    expect(sent.map((entry) => entry.request)).toEqual([
      { cwd: CWD, query: "ab", limit: CONTENT_SEARCH_PAGE_LIMIT, wholeWord: true },
      {
        cwd: CWD,
        query: "ab",
        limit: CONTENT_SEARCH_PAGE_LIMIT,
        caseSensitive: true,
        wholeWord: true,
      },
    ]);
  });

  it("starts a restored search at once", async () => {
    const { sent } = harness({ query: "ab", options: { caseSensitive: true, wholeWord: false } });
    await settle();
    expect(sent.map((entry) => entry.request)).toEqual([
      { cwd: CWD, query: "ab", limit: CONTENT_SEARCH_PAGE_LIMIT, caseSensitive: true },
    ]);
  });

  it("pages with the node's cursor until no cursor follows", async () => {
    const { search, sent, snapshot } = harness({ pageLimit: 2 });
    await type(search, "ab");
    sent[0]!.resolve({
      matches: [match("a.ts"), match("b.ts")],
      nextCursor: "v1:b.ts",
      partial: true,
    });
    await settle();
    expect(snapshot()).toMatchObject({ hasMore: true, partial: true });

    search.loadMore();
    search.loadMore();
    expect(snapshot().loadingMore).toBe(true);
    await settle();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.request).toEqual({ cwd: CWD, query: "ab", limit: 2, cursor: "v1:b.ts" });

    sent[1]!.resolve({ matches: [match("c.ts")] });
    await settle();
    expect(snapshot()).toMatchObject({
      matches: [match("a.ts"), match("b.ts"), match("c.ts")],
      hasMore: false,
      loadingMore: false,
      // The workspace was only partly searched, whatever the later pages say.
      partial: true,
    });
    search.loadMore();
    await settle();
    expect(sent).toHaveLength(2);
  });

  it("stops paging at the loaded-match cap", async () => {
    const { search, sent, snapshot } = harness({ pageLimit: 2, maxLoadedMatches: 3 });
    await type(search, "ab");
    sent[0]!.resolve({ matches: [match("a.ts"), match("b.ts")], nextCursor: "v1:b.ts" });
    await settle();
    search.loadMore();
    await settle();
    sent[1]!.resolve({ matches: [match("c.ts"), match("d.ts")], nextCursor: "v1:d.ts" });
    await settle();
    expect(snapshot()).toMatchObject({ hasMore: true, capped: true });

    search.loadMore();
    search.keepSearching();
    await settle();
    expect(sent).toHaveLength(2);
  });

  it("waits for keepSearching after a page that ran out of time without matches", async () => {
    const { search, sent, snapshot } = harness();
    await type(search, "ab");
    sent[0]!.resolve({ matches: [], timedOut: true, nextCursor: "v1s:m.ts" });
    await settle();
    expect(snapshot()).toMatchObject({ status: "ready", timedOut: true, stoppedEarly: true });
    search.loadMore();
    await settle();
    expect(sent).toHaveLength(1);

    search.keepSearching();
    await settle();
    expect(sent[1]!.request.cursor).toBe("v1s:m.ts");
    sent[1]!.resolve({ matches: [match("x.ts")], timedOut: true, nextCursor: "v1s:x.ts" });
    await settle();
    // It found something, so the list may page on by itself.
    expect(snapshot()).toMatchObject({ timedOut: true, stoppedEarly: false, hasMore: true });
    search.keepSearching();
    search.loadMore();
    await settle();
    expect(sent.map((entry) => entry.request.cursor)).toEqual([undefined, "v1s:m.ts", "v1s:x.ts"]);
  });

  it("reports a failed first page and searches again on retry", async () => {
    const { search, sent, snapshot } = harness();
    await type(search, "ab");
    sent[0]!.reject(new Error("The environment is offline."));
    await settle();
    expect(snapshot()).toMatchObject({
      status: "error",
      matches: [],
      error: { reason: "failed", message: "The environment is offline." },
    });

    search.retry();
    expect(snapshot()).toMatchObject({ status: "searching", error: null });
    await settle();
    expect(sent[1]!.request).toEqual(sent[0]!.request);
  });

  it("keeps the loaded matches when a next page fails, and retries that page", async () => {
    const { search, sent, snapshot } = harness();
    await type(search, "ab");
    sent[0]!.resolve({ matches: [match("a.ts")], nextCursor: "v1:a.ts" });
    await settle();
    search.loadMore();
    await settle();
    sent[1]!.reject(searchFailed("failed", "Failed to search workspace contents: busy"));
    await settle();
    expect(snapshot()).toMatchObject({
      status: "error",
      matches: [match("a.ts")],
      loadingMore: false,
      error: { reason: "failed" },
    });

    search.retry();
    expect(snapshot()).toMatchObject({ status: "ready", loadingMore: true, error: null });
    await settle();
    expect(sent[2]!.request.cursor).toBe("v1:a.ts");
  });

  it("starts over when the node can't continue the cursor", async () => {
    const { search, sent, snapshot } = harness();
    await type(search, "ab");
    sent[0]!.resolve({ matches: [match("a.ts")], nextCursor: "v1:a.ts" });
    await settle();
    search.loadMore();
    await settle();
    sent[1]!.reject(searchFailed("cursor", "This search can't continue. Search again."));
    await settle();
    expect(snapshot().error).toEqual({
      reason: "cursor",
      message: "This search can't continue. Search again.",
    });

    search.retry();
    await settle();
    expect(sent[2]!.request.cursor).toBeUndefined();
  });

  it("aborts what is in flight on dispose and publishes nothing afterwards", async () => {
    const { search, sent, listener } = harness();
    await type(search, "ab");
    search.dispose();
    expect(sent[0]!.signal.aborted).toBe(true);
    const published = listener.mock.calls.length;

    sent[0]!.resolve({ matches: [match("a.ts")] });
    await settle();
    search.setQuery("abc");
    search.setOptions({ caseSensitive: true });
    await vi.advanceTimersByTimeAsync(CONTENT_SEARCH_DEBOUNCE_MS);
    expect(sent).toHaveLength(1);
    expect(listener).toHaveBeenCalledTimes(published);
    expect(search.getSnapshot().matches).toEqual([]);
  });

  it("drops a search still waiting for typing to pause on dispose", async () => {
    const { search, sent } = harness();
    search.setQuery("ab");
    search.dispose();
    await vi.advanceTimersByTimeAsync(CONTENT_SEARCH_DEBOUNCE_MS);
    expect(sent).toHaveLength(0);
  });
});
