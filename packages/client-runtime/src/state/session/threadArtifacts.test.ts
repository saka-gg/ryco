import { MessageId, ThreadId, TurnId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ChatAttachment } from "../threads/types.ts";
import {
  deriveThreadArtifacts,
  readMessageArtifacts,
  type ThreadArtifactSource,
} from "./threadArtifacts.ts";

const turnId = TurnId.make("turn-1");
const at = (second: number) => `2026-10-07T12:00:${String(second).padStart(2, "0")}.000Z`;
const page = (id: string): ChatAttachment => ({
  type: "file",
  id,
  name: "Mockup.html",
  mimeType: "text/html",
  sizeBytes: 10,
  htmlRender: { title: `Page ${id}`, height: 300 },
});
const file = (id: string): ChatAttachment => ({
  type: "file",
  id,
  name: `${id}.mp3`,
  mimeType: "audio/mpeg",
  sizeBytes: 20,
});
const image = (id: string): ChatAttachment => ({
  type: "image",
  id,
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: 30,
});
const message = (
  id: string,
  second: number,
  attachments: ChatAttachment[] | undefined,
  role: ThreadArtifactSource["role"] = "assistant",
): ThreadArtifactSource => ({
  id: MessageId.make(id),
  role,
  turnId,
  createdAt: at(second),
  ...(attachments ? { attachments } : {}),
});

describe("readMessageArtifacts", () => {
  it("reads an assistant message's pages and files in the order it published them", () => {
    const artifacts = readMessageArtifacts(
      message("m1", 1, [file("audio"), page("chart"), image("shot")]),
    );
    expect(artifacts.map((artifact) => [artifact.kind, artifact.key])).toEqual([
      ["file", "m1:audio"],
      ["page", "m1:chart"],
      ["file", "m1:shot"],
    ]);
    const chart = artifacts[1];
    expect(chart?.kind === "page" ? chart.htmlRender.title : null).toBe("Page chart");
    expect(chart).toMatchObject({ messageId: "m1", turnId, createdAt: at(1) });
  });

  it("reads artifacts handed over on any message, with where they came from", () => {
    const handoff = { threadId: ThreadId.make("parent"), messageId: MessageId.make("source") };
    const handedOver = { ...page("copy"), handoff } as ChatAttachment;
    const artifacts = readMessageArtifacts(
      message("m1", 1, [handedOver, image("own-upload")], "user"),
    );
    expect(artifacts.map((artifact) => [artifact.key, artifact.handoff])).toEqual([
      ["m1:copy", handoff],
    ]);
    expect(readMessageArtifacts(message("m2", 2, [page("own")]))[0]?.handoff).toBeNull();
  });

  it("never reads the user's uploads, or attachments of unknown types", () => {
    expect(readMessageArtifacts(message("m1", 1, [image("upload")], "user"))).toEqual([]);
    expect(
      readMessageArtifacts(
        message("m2", 2, [{ type: "voice", id: "note", name: "note.ogg" } as ChatAttachment]),
      ),
    ).toEqual([]);
    expect(readMessageArtifacts(message("m3", 3, undefined))).toEqual([]);
  });

  it("reads each message object once", () => {
    const source = message("m1", 1, [page("chart")]);
    expect(readMessageArtifacts(source)).toBe(readMessageArtifacts(source));
  });
});

describe("deriveThreadArtifacts", () => {
  it("lists artifacts newest message first, then the earlier ones read further back", () => {
    const artifacts = deriveThreadArtifacts(
      [
        message("m3", 3, [page("a")]),
        message("m4", 4, undefined),
        message("m5", 5, [file("b"), page("c")]),
      ],
      [message("m1", 1, [image("d")]), message("m2", 2, [page("e")])],
    );
    expect(artifacts.map((artifact) => artifact.key)).toEqual([
      "m5:b",
      "m5:c",
      "m3:a",
      "m2:e",
      "m1:d",
    ]);
  });

  it("reads a message that is both loaded and further back as loaded", () => {
    const artifacts = deriveThreadArtifacts(
      [message("m2", 2, [page("live")])],
      [message("m2", 2, [page("stale")]), message("m1", 1, [page("older")])],
    );
    expect(artifacts.map((artifact) => artifact.key)).toEqual(["m2:live", "m1:older"]);
  });

  it("keeps a loaded message's own copy when it no longer carries the artifact", () => {
    const artifacts = deriveThreadArtifacts(
      [message("m2", 2, undefined)],
      [message("m2", 2, [page("gone")])],
    );
    expect(artifacts).toEqual([]);
  });
});
