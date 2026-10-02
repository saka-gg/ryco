import { describe, expect, it } from "vite-plus/test";
import { OpenCodePartIndex } from "./openCodePartIndex.ts";

const part = (id: string, messageID = "message", sessionID = "session") => ({
  type: "text" as const,
  id,
  messageID,
  sessionID,
  text: "Body that must be released when the part completes",
});

describe("OpenCode active part index", () => {
  it("indexes out-of-order parts by message and session without scanning prior messages", () => {
    const index = new OpenCodePartIndex();
    for (let i = 0; i < 1_000; i++) index.set(part(`${i}`, `other-${i}`));
    index.set(part("target"));
    index.set(part("target", "message", "child"));
    expect([...index.forMessage("session", "message")]).toEqual([part("target")]);
    expect([...index.forMessage("child", "message")]).toEqual([part("target", "message", "child")]);
  });

  it("releases bodies and emitted text while rejecting late full snapshots and deltas", () => {
    const index = new OpenCodePartIndex();
    index.set(part("one"));
    index.setEmittedText("session:one", "large emitted body");
    index.complete("session:one");
    expect(index.get("session:one")).toBeUndefined();
    expect(index.emittedText("session:one")).toBeUndefined();
    expect([...index.forMessage("session", "message")]).toEqual([]);
    expect(index.set(part("one"))).toBe(false);
    expect(index.isTerminal("session:one")).toBe(true);
    expect(index.set(part("one", "message", "child"))).toBe(true);
  });

  it("retires all parts of a removed message, including late previously unseen parts", () => {
    const index = new OpenCodePartIndex();
    index.set(part("one"));
    index.set(part("two"));
    index.removeMessage("session", "message");
    expect(index.get("session:one")).toBeUndefined();
    expect(index.get("session:two")).toBeUndefined();
    expect(index.set(part("late"))).toBe(false);
    expect(index.set(part("new", "new-message"))).toBe(true);
  });

  it("can release user message bodies without suppressing subsequent synthetic task updates", () => {
    const index = new OpenCodePartIndex();
    index.set(part("user"));
    index.releaseMessageBodies("session", "message");
    expect(index.get("session:user")).toBeUndefined();
    expect([...index.forMessage("session", "message")]).toEqual([]);
    expect(index.set(part("user"))).toBe(true);
  });
});
