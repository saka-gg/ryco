import { MessageId } from "@ryco/contracts";
import { describe, expect, it } from "vitest";
import { captureThreadReadContent, decodeThreadReadContent } from "./readCache.ts";

describe("cached conversation display data", () => {
  const message = {
    id: MessageId.make("m1"),
    role: "assistant" as const,
    text: "saved answer",
    createdAt: "2026-10-01T00:00:00Z",
    streaming: true,
  };
  it("keeps bounded text without streaming state, attachment URLs, or extra fields", () => {
    const saved = captureThreadReadContent([
      { ...message, attachments: [], secret: "not display data" } as typeof message,
    ]);
    expect(saved.messages[0]).toMatchObject({ text: "saved answer", streaming: false });
    expect(saved.messages[0]).not.toHaveProperty("attachments");
    expect(saved.messages[0]).not.toHaveProperty("secret");
    expect(decodeThreadReadContent(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    expect(
      captureThreadReadContent(
        Array.from({ length: 200 }, (_, i) => ({ ...message, id: MessageId.make(`m${i}`) })),
      ).messages,
    ).toHaveLength(150);
  });
  it("rejects malformed, duplicate, and oversized saved messages", () => {
    expect(decodeThreadReadContent({ messages: [message, message] })).toBeNull();
    expect(decodeThreadReadContent({ messages: [{ ...message, text: null }] })).toBeNull();
    expect(
      decodeThreadReadContent({ messages: [{ ...message, text: "x".repeat(1_000_001) }] }),
    ).toBeNull();
    expect(decodeThreadReadContent({ messages: [{ ...message, role: "command" }] })).toBeNull();
  });
});
