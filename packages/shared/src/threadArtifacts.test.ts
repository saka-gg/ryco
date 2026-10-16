import { describe, expect, it } from "vite-plus/test";

import {
  formatThreadArtifactId,
  isThreadArtifactAttachment,
  parseThreadArtifactId,
} from "./threadArtifacts.ts";

describe("thread artifact ids", () => {
  it("round-trips a message id that itself contains colons", () => {
    const id = formatThreadArtifactId({ messageId: "thread:inherited:m1", attachmentId: "t-1" });
    expect(id).toBe("thread:inherited:m1:t-1");
    expect(parseThreadArtifactId(id)).toEqual({
      messageId: "thread:inherited:m1",
      attachmentId: "t-1",
    });
  });

  it("names nothing without a message, or with an attachment id no attachment can have", () => {
    expect(parseThreadArtifactId("only-attachment")).toBeNull();
    expect(parseThreadArtifactId(":attachment")).toBeNull();
    expect(parseThreadArtifactId("message:has space")).toBeNull();
    expect(parseThreadArtifactId(`m:${"a".repeat(129)}`)).toBeNull();
  });
});

describe("isThreadArtifactAttachment", () => {
  const file = { type: "file", id: "f" };
  it("counts the agent's stored images and files, and handed-over ones on any message", () => {
    expect(isThreadArtifactAttachment("assistant", file)).toBe(true);
    expect(isThreadArtifactAttachment("assistant", { type: "image", id: "i" })).toBe(true);
    expect(isThreadArtifactAttachment("user", file)).toBe(false);
    expect(
      isThreadArtifactAttachment("user", { ...file, handoff: { threadId: "p", messageId: "m" } }),
    ).toBe(true);
  });

  it("never counts attachments without a stored file", () => {
    expect(isThreadArtifactAttachment("assistant", { type: "voice", id: "v" })).toBe(false);
    expect(isThreadArtifactAttachment("assistant", { type: "file" })).toBe(false);
  });
});
