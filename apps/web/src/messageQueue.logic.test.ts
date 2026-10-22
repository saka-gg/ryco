import { describe, expect, it } from "vite-plus/test";

import {
  moveQueuedMessage,
  removeQueuedMessage,
  summarizeQueuedMessage,
  type QueuedMessage,
} from "./messageQueue.logic";

function makeMessage(id: string, composer: Partial<QueuedMessage["composer"]> = {}): QueuedMessage {
  return {
    id,
    composer: {
      prompt: "",
      trimmedPrompt: "",
      images: [],
      sendableTerminalContexts: [],
      sourceControlContexts: [],
      ...composer,
    } as QueuedMessage["composer"],
    settings: {
      runtimeMode: "full-access",
      interactionMode: "default",
      tokenMode: "balanced",
    } as QueuedMessage["settings"],
  };
}

describe("removeQueuedMessage", () => {
  it("removes the matching message", () => {
    const queue = [makeMessage("a"), makeMessage("b"), makeMessage("c")];
    expect(removeQueuedMessage(queue, "b").map((m) => m.id)).toEqual(["a", "c"]);
  });

  it("is a no-op when the id is absent", () => {
    const queue = [makeMessage("a")];
    expect(removeQueuedMessage(queue, "z").map((m) => m.id)).toEqual(["a"]);
  });
});

describe("moveQueuedMessage", () => {
  it("moves a message up", () => {
    const queue = [makeMessage("a"), makeMessage("b"), makeMessage("c")];
    expect(moveQueuedMessage(queue, "b", "up").map((m) => m.id)).toEqual(["b", "a", "c"]);
  });

  it("moves a message down", () => {
    const queue = [makeMessage("a"), makeMessage("b"), makeMessage("c")];
    expect(moveQueuedMessage(queue, "b", "down").map((m) => m.id)).toEqual(["a", "c", "b"]);
  });

  it("clamps at the top", () => {
    const queue = [makeMessage("a"), makeMessage("b")];
    expect(moveQueuedMessage(queue, "a", "up").map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("clamps at the bottom", () => {
    const queue = [makeMessage("a"), makeMessage("b")];
    expect(moveQueuedMessage(queue, "b", "down").map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("is a no-op when the id is absent", () => {
    const queue = [makeMessage("a")];
    expect(moveQueuedMessage(queue, "z", "up").map((m) => m.id)).toEqual(["a"]);
  });
});

describe("summarizeQueuedMessage", () => {
  it("uses the trimmed prompt", () => {
    expect(summarizeQueuedMessage(makeMessage("a", { trimmedPrompt: "Fix the bug" }))).toBe(
      "Fix the bug",
    );
  });

  it("truncates long prompts", () => {
    const long = "x".repeat(300);
    const summary = summarizeQueuedMessage(makeMessage("a", { trimmedPrompt: long }));
    expect(summary.length).toBe(120);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("falls back to image count", () => {
    expect(
      summarizeQueuedMessage(
        makeMessage("a", { images: [{}, {}] as QueuedMessage["composer"]["images"] }),
      ),
    ).toBe("2 images");
  });

  it("falls back to terminal context count", () => {
    expect(
      summarizeQueuedMessage(
        makeMessage("a", {
          sendableTerminalContexts: [{}] as QueuedMessage["composer"]["sendableTerminalContexts"],
        }),
      ),
    ).toBe("1 terminal context");
  });

  it("falls back to file reference count", () => {
    expect(
      summarizeQueuedMessage(
        makeMessage("a", {
          fileReferences: [{}, {}] as NonNullable<QueuedMessage["composer"]["fileReferences"]>,
        }),
      ),
    ).toBe("2 file references");
  });

  it("falls back to a generic label", () => {
    expect(summarizeQueuedMessage(makeMessage("a"))).toBe("Queued message");
  });
});
