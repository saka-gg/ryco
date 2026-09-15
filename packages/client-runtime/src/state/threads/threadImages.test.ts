import { describe, expect, it } from "vitest";
import { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { collectThreadImages, threadImagesPage } from "./threadImages.ts";
import type { ChatImageAttachment, ChatMessage } from "./types.ts";

const scope = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const image = (id: string): ChatImageAttachment => ({
  type: "image",
  id,
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: 12,
});
const message = (id: string, attachments: ChatMessage["attachments"]): ChatMessage => ({
  id: MessageId.make(id),
  role: "assistant",
  text: "![ignored](https://example.org/image.png)",
  createdAt: "2026-09-15T00:00:00Z",
  streaming: false,
  ...(attachments ? { attachments } : {}),
});

describe("thread image metadata", () => {
  it("reverses canonical message order, preserves attachment order and excludes other media", () => {
    const old = message("old", [image("old")]);
    old.role = "user";
    const recent = message("recent", [
      image("a"),
      { type: "file", id: "file", name: "file.png", mimeType: "image/png", sizeBytes: 12 },
      image("b"),
      { type: "future" },
    ]);
    expect(collectThreadImages(scope, [old, recent]).map((entry) => entry.attachment.id)).toEqual([
      "a",
      "b",
      "old",
    ]);
    expect(collectThreadImages(scope, [message("text", [])])).toEqual([]);
  });
  it("deduplicates replayed references but keeps distinct messages and environments", () => {
    const a = message("a", [image("same"), image("same")]);
    const b = message("b", [image("same")]);
    const entries = collectThreadImages(scope, [a, a, b]);
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(2);
    expect(
      collectThreadImages({ ...scope, environmentId: EnvironmentId.make("other") }, [a])[0]!.key,
    ).not.toBe(entries[1]!.key);
    expect(
      collectThreadImages({ ...scope, threadId: ThreadId.make("other") }, [a])[0]!.key,
    ).not.toBe(entries[1]!.key);
  });
  it("reflects late attachments, removal, and history paging without retaining stale entries", () => {
    const a = message("a", []);
    expect(collectThreadImages(scope, [a])).toEqual([]);
    const attached = { ...a, attachments: [image("late")] };
    expect(collectThreadImages(scope, [attached])).toHaveLength(1);
    expect(collectThreadImages(scope, [message("older", [image("early")]), attached])).toHaveLength(
      2,
    );
    expect(collectThreadImages(scope, [a])).toEqual([]);
    expect(collectThreadImages(scope, [])).toEqual([]);
  });
  it("bounds pages and clamps invalid or stale page positions after removal", () => {
    const entries = collectThreadImages(scope, [
      message(
        "many",
        Array.from({ length: 49 }, (_, i) => image(`${i}`)),
      ),
    ]);
    expect(threadImagesPage(entries, 0).images).toHaveLength(24);
    expect(threadImagesPage(entries, 1).images).toHaveLength(24);
    expect(threadImagesPage(entries, 2).images).toHaveLength(1);
    expect(threadImagesPage(entries, 200).page).toBe(2);
    expect(threadImagesPage(entries, -1).page).toBe(0);
    expect(threadImagesPage(entries, NaN).page).toBe(0);
    expect(threadImagesPage([], 20)).toEqual({ page: 0, pageCount: 1, images: [] });
  });
});
