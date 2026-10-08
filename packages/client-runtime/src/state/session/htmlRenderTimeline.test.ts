import { MessageId, TurnId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ChatAttachment } from "../threads/types.ts";
import {
  collectTurnHtmlRenders,
  deriveTerminalAssistantMessageIds,
  isBlankSettledReply,
  isHtmlRenderOnlyMessage,
  placeRepliesAfterHtmlRenders,
} from "./htmlRenderTimeline.ts";
import type { TimelineEntry } from "./session-logic.ts";

const turnId = TurnId.make("turn-1");
const at = (second: number) => `2026-10-07T12:00:${String(second).padStart(2, "0")}.000Z`;
const render = (id: string): ChatAttachment => ({
  type: "file",
  id,
  name: "Chart.html",
  mimeType: "text/html",
  sizeBytes: 10,
  htmlRender: { title: id, height: 300 },
});
const message = (
  id: string,
  second: number,
  text: string,
  extra: { attachments?: ChatAttachment[]; role?: "user" | "assistant"; streaming?: boolean } = {},
): TimelineEntry => ({
  id: `${id}-entry`,
  kind: "message",
  createdAt: at(second),
  message: {
    id: MessageId.make(id),
    role: extra.role ?? "assistant",
    text,
    turnId: extra.role === "user" ? null : turnId,
    createdAt: at(second),
    streaming: extra.streaming ?? false,
    ...(extra.attachments ? { attachments: extra.attachments } : {}),
  },
});

describe("htmlRenderTimeline", () => {
  it("recognizes render carriers and blank replies", () => {
    const carrier = message("render", 2, " ", { attachments: [render("a")] });
    expect(carrier.kind === "message" && isHtmlRenderOnlyMessage(carrier.message)).toBe(true);
    const blank = message("final", 3, "");
    expect(blank.kind === "message" && isBlankSettledReply(blank.message)).toBe(true);
    const streaming = message("final", 3, "", { streaming: true });
    expect(streaming.kind === "message" && isBlankSettledReply(streaming.message)).toBe(false);
  });

  it("never takes a render for the reply, and moves an early reply below the page", () => {
    const entries = [
      message("user", 0, "Chart it", { role: "user" }),
      message("final", 1, "Here."),
      message("render", 2, " ", { attachments: [render("a"), render("b")] }),
    ];
    const terminal = deriveTerminalAssistantMessageIds(entries);
    expect([...terminal]).toEqual(["final"]);
    expect(placeRepliesAfterHtmlRenders(entries, terminal).map((entry) => entry.id)).toEqual([
      "user-entry",
      "render-entry",
      "final-entry",
    ]);
    expect(
      collectTurnHtmlRenders(entries)
        .get(turnId)
        ?.map((entry) => entry.attachment.id),
    ).toEqual(["a", "b"]);
  });

  it("leaves turns without renders untouched", () => {
    const entries = [message("user", 0, "Hi", { role: "user" }), message("final", 1, "Hello")];
    expect(placeRepliesAfterHtmlRenders(entries, deriveTerminalAssistantMessageIds(entries))).toBe(
      entries,
    );
  });

  it("moves only a still-streaming reply while its turn runs", () => {
    const entries = [
      message("user", 0, "Chart it", { role: "user" }),
      message("narration", 1, "Building the chart."),
      message("render", 2, " ", { attachments: [render("a")] }),
    ];
    const terminal = deriveTerminalAssistantMessageIds(entries);
    const ids = (running: string | null) =>
      placeRepliesAfterHtmlRenders(entries, terminal, { runningTurnId: running }).map(
        (entry) => entry.id,
      );
    expect(ids(turnId)).toEqual(["user-entry", "narration-entry", "render-entry"]);
    expect(ids(null)).toEqual(["user-entry", "render-entry", "narration-entry"]);

    const streaming = [
      message("user", 0, "Chart it", { role: "user" }),
      message("final", 1, "Here", { streaming: true }),
      message("render", 2, " ", { attachments: [render("a")] }),
    ];
    expect(
      placeRepliesAfterHtmlRenders(streaming, deriveTerminalAssistantMessageIds(streaming), {
        runningTurnId: turnId,
      }).map((entry) => entry.id),
    ).toEqual(["user-entry", "render-entry", "final-entry"]);
  });

  it("reads each message once", () => {
    const carrier = message("render", 2, " ", { attachments: [render("a")] });
    if (carrier.kind !== "message") throw new Error("expected a message");
    expect(isHtmlRenderOnlyMessage(carrier.message)).toBe(true);
    Object.defineProperty(carrier.message, "attachments", {
      get: () => {
        throw new Error("read again");
      },
    });
    expect(isHtmlRenderOnlyMessage(carrier.message)).toBe(true);
  });
});
