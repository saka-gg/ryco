import { describe, expect, it } from "vite-plus/test";

import {
  applyThreadReadCacheShellPatch,
  applyThreadReadCacheThreadPatch,
} from "./threadReadCachePatch.ts";

const message = (id: string, text = id) =>
  ({ id, role: "assistant", text, createdAt: "2026-11-10T09:00:00.000Z" }) as never;
const row = (id: string, title = id) => ({ id, title }) as never;
const shell = (threads: ReadonlyArray<unknown>) =>
  ({
    snapshotSequence: 1,
    projects: [],
    threads,
    updatedAt: "2026-11-10T09:00:00.000Z",
  }) as never;

describe("thread read cache patches", () => {
  it("continues stored messages from the first kept one, replacing and appending", () => {
    const stored = { messages: [message("a"), message("b"), message("c")] };
    const applied = applyThreadReadCacheThreadPatch(stored, {
      firstMessageId: "b",
      messages: [message("c", "c, longer"), message("d")],
    } as never);
    expect(applied).toEqual({
      kind: "ok",
      value: { messages: [message("b"), message("c", "c, longer"), message("d")] },
    });
    expect(
      applyThreadReadCacheThreadPatch(stored, { firstMessageId: "x", messages: [] } as never),
    ).toEqual({ kind: "conflict", reason: "first_message" });
  });

  it("replaces rows in place, drops removed ones, appends new ones and checks the count", () => {
    const stored = shell([row("a"), row("b"), row("c")]);
    const patch = {
      revision: 7,
      updatedAt: "2026-11-10T10:00:00.000Z",
      threads: [row("b", "renamed"), row("d")],
      removedThreadIds: ["a"],
      threadCount: 3,
    } as never;
    expect(applyThreadReadCacheShellPatch(stored, patch)).toEqual({
      kind: "ok",
      value: {
        snapshotSequence: 7,
        projects: [],
        threads: [row("b", "renamed"), row("c"), row("d")],
        updatedAt: "2026-11-10T10:00:00.000Z",
      },
    });
    expect(
      applyThreadReadCacheShellPatch(stored, { ...(patch as object), threadCount: 4 } as never),
    ).toEqual({ kind: "conflict", reason: "thread_count" });
  });
});
