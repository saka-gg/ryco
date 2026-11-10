import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../../rpc/atomRegistry.ts";
import {
  createMessageTextQuery,
  MESSAGE_TEXT_PREVIEW_COPY,
  readWholeMessageText,
  resolveMessageTextView,
  type MessageTextInput,
  type MessageTextQueryState,
} from "./messageText.ts";

const environmentId = "env-1" as EnvironmentId;
const threadId = "thread-1" as ThreadId;
const messageId = "message-1" as MessageId;
const input: MessageTextInput = { environmentId, threadId, messageId };

const wholeText = (text: string, truncated = false) => ({
  messageId,
  text,
  fullLength: text.length,
  truncated,
});

let reset: (() => void) | null = null;
afterEach(() => {
  reset?.();
  reset = null;
});

describe("createMessageTextQuery", () => {
  it("reads the whole text through the injected environment API once per key", async () => {
    const getMessageText = vi.fn(async () => wholeText("the whole text"));
    const resolveGetMessageText = vi.fn(() => getMessageText as never);
    const { query, resetForTests } = createMessageTextQuery({ resolveGetMessageText });
    reset = resetForTests;

    const key = query.keyOf(input);
    const release = query.watch(input);
    await vi.waitFor(() => expect(appAtomRegistry.get(query.getAtom(key)).data).not.toBeNull());
    expect(resolveGetMessageText).toHaveBeenCalledWith(environmentId);
    expect(getMessageText).toHaveBeenCalledExactlyOnceWith({ threadId, messageId });
    release();

    // A finished message never changes: showing it again reads the cache.
    const releaseAgain = query.watch(input);
    expect(getMessageText).toHaveBeenCalledOnce();
    releaseAgain();
  });

  it("has no key, and sends nothing, while the whole text is not wanted", () => {
    const getMessageText = vi.fn();
    const { query, resetForTests } = createMessageTextQuery({
      resolveGetMessageText: () => getMessageText as never,
    });
    reset = resetForTests;
    expect(query.keyOf({ ...input, messageId: null })).toBeNull();
    query.watch({ ...input, messageId: null })();
    expect(getMessageText).not.toHaveBeenCalled();
  });

  it("fails the read when the environment cannot load whole messages", async () => {
    const { query, resetForTests } = createMessageTextQuery({
      resolveGetMessageText: () => undefined as never,
    });
    reset = resetForTests;
    const key = query.keyOf(input);
    const release = query.watch(input);
    await vi.waitFor(() => expect(appAtomRegistry.get(query.getAtom(key)).error).not.toBeNull());
    release();
  });
});

describe("resolveMessageTextView", () => {
  const state = (overrides: Partial<MessageTextQueryState>): MessageTextQueryState => ({
    data: null,
    isLoading: false,
    error: null,
    ...overrides,
  });
  const preview = { text: "the head", textPreview: { fullLength: 48_000 } };

  it("shows a whole message's own text and never asks for more", () => {
    expect(resolveMessageTextView({ text: "short" }, null, state({}))).toEqual({
      status: "idle",
      text: "short",
      truncated: false,
      fullLength: null,
    });
    // Even a cached entry does not stand in for a whole message's own text.
    expect(
      resolveMessageTextView({ text: "short" }, "key", state({ data: wholeText("other") })).text,
    ).toBe("short");
  });

  it("shows the preview until the whole text is asked for and arrives", () => {
    expect(resolveMessageTextView(preview, null, state({}))).toEqual({
      status: "idle",
      text: "the head",
      truncated: true,
      fullLength: 48_000,
    });
    expect(resolveMessageTextView(preview, "key", state({ isLoading: true })).status).toBe(
      "loading",
    );
    const failed = resolveMessageTextView(preview, "key", state({ error: new Error("offline") }));
    expect(failed.status).toBe("error");
    expect(failed.text).toBe("the head");
  });

  it("shows the whole text once loaded, still marked when one response cut it short", () => {
    expect(resolveMessageTextView(preview, "key", state({ data: wholeText("all of it") }))).toEqual(
      { status: "loaded", text: "all of it", truncated: false, fullLength: 9 },
    );
    const capped = resolveMessageTextView(
      preview,
      "key",
      state({ data: { ...wholeText("first million"), fullLength: 2_000_000, truncated: true } }),
    );
    expect(capped).toMatchObject({ status: "loaded", truncated: true, fullLength: 2_000_000 });
  });
});

describe("readWholeMessageText", () => {
  it("returns a whole message's own text without a read", async () => {
    const getMessageText = vi.fn();
    const { query, resetForTests } = createMessageTextQuery({
      resolveGetMessageText: () => getMessageText as never,
    });
    reset = resetForTests;
    await expect(
      readWholeMessageText(query, {
        environmentId,
        threadId,
        message: { id: messageId, text: "short" },
      }),
    ).resolves.toBe("short");
    expect(getMessageText).not.toHaveBeenCalled();
  });

  it("reads a preview's whole text once and reuses the cached one", async () => {
    const getMessageText = vi.fn(async () => wholeText("the whole text"));
    const { query, resetForTests } = createMessageTextQuery({
      resolveGetMessageText: () => getMessageText as never,
    });
    reset = resetForTests;
    const target = {
      environmentId,
      threadId,
      message: { id: messageId, text: "the head", textPreview: { fullLength: 14 } },
    };
    await expect(readWholeMessageText(query, target)).resolves.toBe("the whole text");
    await expect(readWholeMessageText(query, target)).resolves.toBe("the whole text");
    expect(getMessageText).toHaveBeenCalledOnce();
  });

  it("joins a read already in flight for the row", async () => {
    let resolveRead: (value: ReturnType<typeof wholeText>) => void = () => undefined;
    const getMessageText = vi.fn(
      () => new Promise<ReturnType<typeof wholeText>>((resolve) => (resolveRead = resolve)),
    );
    const { query, resetForTests } = createMessageTextQuery({
      resolveGetMessageText: () => getMessageText as never,
    });
    reset = resetForTests;
    const releaseRow = query.watch(input);
    const copied = readWholeMessageText(query, {
      environmentId,
      threadId,
      message: { id: messageId, text: "the head", textPreview: { fullLength: 14 } },
    });
    resolveRead(wholeText("the whole text"));
    await expect(copied).resolves.toBe("the whole text");
    expect(getMessageText).toHaveBeenCalledOnce();
    releaseRow();
  });

  it("rejects when the read fails, and reads again on the next try", async () => {
    let fail = true;
    const getMessageText = vi.fn(async () => {
      if (fail) throw new Error("relay dropped");
      return wholeText("the whole text");
    });
    const { query, resetForTests } = createMessageTextQuery({
      resolveGetMessageText: () => getMessageText as never,
    });
    reset = resetForTests;
    const target = {
      environmentId,
      threadId,
      message: { id: messageId, text: "the head", textPreview: { fullLength: 14 } },
    };
    await expect(readWholeMessageText(query, target)).rejects.toThrow("relay dropped");
    fail = false;
    await expect(readWholeMessageText(query, target)).resolves.toBe("the whole text");
  });
});

describe("MESSAGE_TEXT_PREVIEW_COPY", () => {
  it("names the whole message's size", () => {
    expect(MESSAGE_TEXT_PREVIEW_COPY.show(48_000)).toBe("Show whole message (48,000 characters)");
  });
});
