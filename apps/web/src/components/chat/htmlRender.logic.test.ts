import { MessageId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ChatAttachment, ChatMessage } from "../../types";
import { attachmentPreviewKind } from "./attachmentPreview";
import {
  findThreadHtmlRender,
  isHtmlRenderOnlyMessage,
  readHtmlRenderAttachment,
} from "./htmlRender.logic";

const render = {
  type: "file",
  id: "thread-1-abc-html",
  name: "Chart.html",
  mimeType: "text/html",
  sizeBytes: 1200,
  htmlRender: { title: "  Chart  ", height: 9000, heights: [[760, 300]] },
} as const satisfies ChatAttachment;

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: MessageId.make("message-1"),
    role: "assistant",
    text: " ",
    attachments: [render],
    createdAt: "2026-09-04T12:00:00.000Z",
    streaming: false,
    ...overrides,
  };
}

describe("readHtmlRenderAttachment", () => {
  it("reads a text/html file's render metadata, validated and clamped", () => {
    expect(readHtmlRenderAttachment(render)).toEqual({
      attachment: render,
      htmlRender: { title: "Chart", height: 2000, heights: [[760, 300]] },
    });
  });

  it("validates each attachment object once", () => {
    const withThumbnail = {
      ...render,
      htmlRender: { ...render.htmlRender, thumbnails: { dark: "data:image/webp;base64,AAAA" } },
    } satisfies ChatAttachment;
    const first = readHtmlRenderAttachment(withThumbnail);
    expect(first?.htmlRender.thumbnails).toEqual({ dark: "data:image/webp;base64,AAAA" });
    // The same object reads as the same render; a replaced one is read anew.
    expect(readHtmlRenderAttachment(withThumbnail)).toBe(first);
    const replaced = {
      ...withThumbnail,
      htmlRender: { ...withThumbnail.htmlRender, title: "New" },
    };
    expect(readHtmlRenderAttachment(replaced)?.htmlRender.title).toBe("New");
    const plain = { ...render, mimeType: "text/plain" } satisfies ChatAttachment;
    expect(readHtmlRenderAttachment(plain)).toBeUndefined();
    expect(readHtmlRenderAttachment(plain)).toBeUndefined();
  });

  it.each([
    ["a plain HTML file", { ...render, htmlRender: undefined }],
    ["a non-HTML file", { ...render, mimeType: "application/javascript" }],
    ["an image", { ...render, type: "image" }],
    ["malformed metadata", { ...render, htmlRender: { title: 3, height: "tall" } }],
  ] as const)("ignores %s", (_label, attachment) => {
    expect(readHtmlRenderAttachment(attachment as ChatAttachment)).toBeUndefined();
  });

  it("keeps plain HTML files a text preview, never an executable view", () => {
    expect(attachmentPreviewKind({ name: "page.html", mimeType: "text/html" })).toBe("text");
    expect(attachmentPreviewKind({ name: "page.html", mimeType: "" })).toBe("text");
  });
});

describe("isHtmlRenderOnlyMessage", () => {
  it("matches a finished assistant message that only carries renders", () => {
    expect(isHtmlRenderOnlyMessage(message({}))).toBe(true);
    expect(isHtmlRenderOnlyMessage(message({ text: "" }))).toBe(true);
    expect(
      isHtmlRenderOnlyMessage(message({ attachments: [render, { ...render, id: "b" }] })),
    ).toBe(true);
  });

  it.each([
    ["has text of its own", { text: "Here is the chart." }],
    ["is still streaming", { streaming: true }],
    ["is the user's", { role: "user" as const }],
    ["has no attachments", { attachments: [] }],
    [
      "also carries another file",
      {
        attachments: [
          render,
          { type: "file", id: "log", name: "a.log", mimeType: "text/plain", sizeBytes: 4 },
        ],
      },
    ],
  ] as const)("does not match a message that %s", (_label, overrides) => {
    expect(isHtmlRenderOnlyMessage(message(overrides as Partial<ChatMessage>))).toBe(false);
  });
});

describe("findThreadHtmlRender", () => {
  const messages = [
    message({ id: MessageId.make("prompt"), role: "user", text: "Chart it", attachments: [] }),
    message({}),
  ];

  it("finds a render by its message and attachment", () => {
    expect(
      findThreadHtmlRender(messages, {
        messageId: MessageId.make("message-1"),
        attachmentId: "thread-1-abc-html",
      }),
    ).toEqual({ attachment: render, htmlRender: expect.objectContaining({ title: "Chart" }) });
  });

  it.each([
    ["a message the thread no longer has", "gone", "thread-1-abc-html"],
    ["an attachment the message does not carry", "message-1", "other-html"],
    ["a message without attachments", "prompt", "thread-1-abc-html"],
  ])("finds nothing for %s", (_label, messageId, attachmentId) => {
    expect(
      findThreadHtmlRender(messages, { messageId: MessageId.make(messageId), attachmentId }),
    ).toBeUndefined();
  });

  it("finds nothing for an attachment that is not a render", () => {
    expect(
      findThreadHtmlRender([message({ attachments: [{ ...render, htmlRender: undefined }] })], {
        messageId: MessageId.make("message-1"),
        attachmentId: "thread-1-abc-html",
      }),
    ).toBeUndefined();
  });
});
