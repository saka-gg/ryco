import type { NodeBrowserInputEvent } from "@ryco/contracts/node-browser";
import { describe, expect, it } from "vitest";

import {
  createClickCounter,
  createNodeBrowserInputQueue,
  keyInput,
  letterboxPoint,
  textInputs,
  wheelPixels,
} from "./viewerInput.ts";

const box = { left: 10, top: 20, width: 400, height: 400 };

describe("node browser viewer input", () => {
  it("maps a point on a letterboxed frame to page CSS pixels", () => {
    // A 200 x 100 image of a 1000 x 500 page, shown 400 x 200 in the middle of a 400 x 400 box.
    const frame = { width: 200, height: 100 };
    const viewport = { width: 1000, height: 500 };
    const at = (clientX: number, clientY: number, clamp = false) =>
      letterboxPoint({ box, frame, viewport, clientX, clientY, clamp });
    expect(at(10 + 200, 20 + 200)).toEqual({ x: 500, y: 250, scale: 2.5 });
    expect(at(10, 20 + 100)).toEqual({ x: 0, y: 0, scale: 2.5 });
    // The bars above and below the frame are not the page, unless a drag is pinned to it.
    expect(at(10 + 200, 20 + 50)).toBeNull();
    expect(at(10 + 200, 20 + 50, true)).toEqual({ x: 500, y: 0, scale: 2.5 });
    expect(
      letterboxPoint({
        box,
        frame: { width: 0, height: 0 },
        viewport,
        clientX: 0,
        clientY: 0,
        clamp: true,
      }),
    ).toBeNull();
  });

  it("counts wheel lines as 16 px and pages as the viewport's height", () => {
    expect(wheelPixels(3, 0, 800)).toBe(3);
    expect(wheelPixels(3, 1, 800)).toBe(48);
    expect(wheelPixels(-1, 2, 800)).toBe(-800);
  });

  it("counts double and triple clicks within 500 ms and 4 px", () => {
    const clicks = createClickCounter();
    expect(clicks.count("left", 10, 10, 0)).toBe(1);
    expect(clicks.count("left", 12, 11, 300)).toBe(2);
    expect(clicks.count("left", 12, 11, 600)).toBe(3);
    expect(clicks.count("left", 12, 11, 1200)).toBe(1);
    expect(clicks.count("right", 12, 11, 1300)).toBe(1);
    expect(clicks.count("right", 30, 11, 1400)).toBe(1);
  });

  it("keeps composition, paste and the leave shortcut away from the page", () => {
    const key = (key: string, extra: Partial<Parameters<typeof keyInput>[1]> = {}) =>
      keyInput("down", {
        key,
        code: `Key${key.toUpperCase()}`,
        keyCode: key.toUpperCase().charCodeAt(0),
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        isComposing: false,
        ...extra,
      });
    expect(key("a")).toMatchObject({ type: "key", key: "a", text: "a", keyCode: 65, modifiers: 0 });
    expect(key("Enter")).toMatchObject({ text: "\r" });
    expect(key("a", { metaKey: true })).toEqual({
      type: "key",
      action: "down",
      key: "a",
      code: "KeyA",
      keyCode: 65,
      modifiers: 4,
    });
    expect(key("v", { ctrlKey: true })).toBeNull();
    expect(key("Escape", { shiftKey: true })).toBeNull();
    expect(key("a", { isComposing: true })).toBeNull();
    expect(key("Process")).toBeNull();
  });

  it("splits long text to the node's limit per event", () => {
    expect(
      textInputs("x".repeat(25_000)).map((event) => event.type === "text" && event.text.length),
    ).toEqual([10_000, 10_000, 5_000]);
  });
});

describe("node browser input queue", () => {
  const harness = () => {
    const sent: Array<ReadonlyArray<NodeBrowserInputEvent>> = [];
    const answers: Array<() => void> = [];
    const frames: Array<() => void> = [];
    const queue = createNodeBrowserInputQueue({
      send: (events) => {
        sent.push(events);
        return new Promise<void>((resolve) => answers.push(resolve));
      },
      schedule: (flush) => {
        frames.push(flush);
        return () => {
          const index = frames.indexOf(flush);
          if (index !== -1) frames.splice(index, 1);
        };
      },
    });
    const answer = async () => {
      answers.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { queue, sent, frames, answer };
  };
  const mouse = (action: "move" | "down" | "up", x: number): NodeBrowserInputEvent => ({
    type: "mouse",
    action,
    x,
    y: 0,
    button: action === "move" ? "none" : "left",
    buttons: action === "down" ? 1 : 0,
    clickCount: action === "move" ? 0 : 1,
    modifiers: 0,
  });
  const wheel = (deltaY: number): NodeBrowserInputEvent => ({
    type: "wheel",
    x: 0,
    y: 0,
    deltaX: 0,
    deltaY,
    modifiers: 0,
  });

  it("sends one move and one summed wheel per frame", () => {
    const { queue, sent, frames } = harness();
    queue.push(mouse("move", 1));
    queue.push(mouse("move", 2));
    queue.push(wheel(16));
    queue.push(wheel(32));
    expect(sent).toEqual([]);
    expect(frames).toHaveLength(1);
    frames[0]!();
    expect(sent).toEqual([[mouse("move", 2), wheel(48)]]);
  });

  it("sends a press at once, after the moves before it, and one call at a time in order", async () => {
    const { queue, sent, frames, answer } = harness();
    queue.push(mouse("move", 1));
    queue.push(mouse("down", 1));
    expect(sent).toEqual([[mouse("move", 1), mouse("down", 1)]]);
    expect(frames).toHaveLength(0);
    queue.push(mouse("up", 1));
    queue.push({ type: "text", text: "hi" });
    expect(sent).toHaveLength(1);
    await answer();
    expect(sent[1]).toEqual([mouse("up", 1), { type: "text", text: "hi" }]);
  });

  it("splits a backlog into calls of at most 64 events", async () => {
    const { queue, sent, answer } = harness();
    queue.push(mouse("down", 0));
    for (let index = 0; index < 70; index += 1) queue.push({ type: "text", text: "x" });
    await answer();
    expect(sent.map((events) => events.length)).toEqual([1, 64]);
    await answer();
    expect(sent.map((events) => events.length)).toEqual([1, 64, 6]);
  });

  it("drops what is not sent once stopped", async () => {
    const { queue, sent, answer } = harness();
    queue.push(mouse("down", 0));
    queue.push(mouse("up", 0));
    queue.stop();
    await answer();
    queue.push(mouse("down", 0));
    expect(sent).toHaveLength(1);
  });
});
