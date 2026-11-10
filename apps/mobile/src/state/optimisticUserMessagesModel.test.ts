import type { ChatMessage } from "@ryco/client-runtime/state/threads";
import type { MessageId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { DraftComposerAttachment } from "../lib/composerFiles";
import {
  addOptimisticMessage,
  buildOptimisticUserMessage,
  MAX_OPTIMISTIC_MESSAGES_PER_THREAD,
  MAX_OPTIMISTIC_THREADS,
  mergeOptimisticMessages,
  mergeRestoredDraft,
  settleOptimisticMessages,
  updateOptimisticMessage,
} from "./optimisticUserMessagesModel";

const image: DraftComposerAttachment = {
  type: "image",
  id: "img-1",
  name: "a.png",
  mimeType: "image/png",
  sizeBytes: 10,
  dataUrl: "data:image/png;base64,AAAA",
  previewUri: "file:///a.png",
};
const file: DraftComposerAttachment = {
  type: "file",
  id: "file-1",
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 5,
  readUri: "file:///notes.txt",
};

function pending(id: string, prompt = `text ${id}`) {
  return buildOptimisticUserMessage({
    messageId: id as MessageId,
    text: prompt,
    createdAt: "2026-11-10T10:00:00.000Z",
    prompt,
    attachments: [],
  });
}

function server(id: string): ChatMessage {
  return {
    id: id as MessageId,
    role: "user",
    text: id,
    createdAt: "2026-11-10T09:00:00.000Z",
    streaming: false,
  };
}

describe("optimistic user messages", () => {
  it("builds a user message with local previews and plain file rows", () => {
    const entry = buildOptimisticUserMessage({
      messageId: "m1" as MessageId,
      text: "hello",
      createdAt: "2026-11-10T10:00:00.000Z",
      prompt: "hello",
      attachments: [image, file],
    });
    expect(entry.phase).toBe("sending");
    expect(entry.message).toMatchObject({
      id: "m1",
      role: "user",
      text: "hello",
      streaming: false,
    });
    expect(entry.message.attachments).toEqual([
      {
        type: "image",
        id: "img-1",
        name: "a.png",
        mimeType: "image/png",
        sizeBytes: 10,
        previewUrl: "file:///a.png",
      },
      { type: "file", id: "file-1", name: "notes.txt", mimeType: "text/plain", sizeBytes: 5 },
    ]);
  });

  it("appends unconfirmed sends after the node's messages and returns the node's array otherwise", () => {
    const messages = [server("s1")];
    expect(mergeOptimisticMessages(messages, undefined)).toBe(messages);
    expect(mergeOptimisticMessages(messages, [])).toBe(messages);
    const merged = mergeOptimisticMessages(messages, [pending("m1"), pending("m2")]);
    expect(merged.map((message) => message.id)).toEqual(["s1", "m1", "m2"]);
    // The echo is in: the node's copy stands alone.
    const echoed = [server("s1"), server("m1"), server("m2")];
    expect(mergeOptimisticMessages(echoed, [pending("m1"), pending("m2")])).toBe(echoed);
  });

  it("hides failed sends from the timeline", () => {
    const messages = [server("s1")];
    const failed = { ...pending("m1"), phase: "failed" as const };
    expect(mergeOptimisticMessages(messages, [failed])).toBe(messages);
  });

  it("adds once per id, keeps order, and caps a thread's sends", () => {
    let state = addOptimisticMessage({}, "k", pending("m1"));
    expect(addOptimisticMessage(state, "k", pending("m1"))).toBe(state);
    for (let index = 2; index <= MAX_OPTIMISTIC_MESSAGES_PER_THREAD + 1; index += 1) {
      state = addOptimisticMessage(state, "k", pending(`m${index}`));
    }
    const ids = state.k!.map((entry) => entry.message.id);
    expect(ids).toHaveLength(MAX_OPTIMISTIC_MESSAGES_PER_THREAD);
    expect(ids[0]).toBe("m2");
    expect(ids.at(-1)).toBe(`m${MAX_OPTIMISTIC_MESSAGES_PER_THREAD + 1}`);
  });

  it("drops the least recently written thread past the thread cap", () => {
    let state = {};
    for (let index = 0; index <= MAX_OPTIMISTIC_THREADS; index += 1) {
      state = addOptimisticMessage(state, `k${index}`, pending(`m${index}`));
    }
    expect(Object.keys(state)).toHaveLength(MAX_OPTIMISTIC_THREADS);
    expect(Object.keys(state)).not.toContain("k0");
  });

  it("updates, removes and settles by id, keeping identity when nothing changes", () => {
    let state = addOptimisticMessage({}, "k", pending("m1"));
    state = addOptimisticMessage(state, "k", pending("m2"));
    const same = updateOptimisticMessage(state, "k", "missing", () => null);
    expect(same).toBe(state);
    state = updateOptimisticMessage(state, "k", "m1", (entry) => ({
      ...entry,
      phase: "dispatched",
    }));
    expect(state.k!.map((entry) => entry.phase)).toEqual(["dispatched", "sending"]);
    expect(settleOptimisticMessages(state, "k", new Set(["other"]))).toBe(state);
    state = settleOptimisticMessages(state, "k", new Set(["m1"]));
    expect(state.k!.map((entry) => entry.message.id)).toEqual(["m2"]);
    state = updateOptimisticMessage(state, "k", "m2", () => null);
    expect(state).toEqual({});
  });

  it("restores failed drafts before what is typed now, without duplicate attachments", () => {
    expect(
      mergeRestoredDraft(
        [
          { prompt: "first", attachments: [image] },
          { prompt: "second", attachments: [file] },
        ],
        { prompt: "typed since", attachments: [image] },
      ),
    ).toEqual({ prompt: "first\n\nsecond\n\ntyped since", attachments: [image, file] });
    expect(
      mergeRestoredDraft([{ prompt: "only", attachments: [] }], { prompt: "  ", attachments: [] }),
    ).toEqual({ prompt: "only", attachments: [] });
  });
});
