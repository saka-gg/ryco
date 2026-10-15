import { describe, expect, it } from "vite-plus/test";

import { makeCheckoutGenerations } from "./checkoutGenerations.ts";

describe("makeCheckoutGenerations", () => {
  it("moves a checkout's generation on each bump and leaves others alone", () => {
    const generations = makeCheckoutGenerations(8);
    const before = generations.get("/a");
    generations.bump("/a");
    const afterFirst = generations.get("/a");
    generations.bump("/a");
    expect(afterFirst).not.toBe(before);
    expect(generations.get("/a")).not.toBe(afterFirst);
    expect(generations.get("/b")).toBe(before);
  });

  it("never lets an evicted checkout read a value captured before its bump", () => {
    const generations = makeCheckoutGenerations(2);
    const captured = generations.get("/a");
    generations.bump("/a");
    // `/a` is evicted as the least recently bumped checkout.
    generations.bump("/b");
    generations.bump("/c");
    expect(generations.get("/a")).not.toBe(captured);

    const capturedAfterEviction = generations.get("/a");
    generations.bump("/a");
    expect(generations.get("/a")).not.toBe(capturedAfterEviction);
  });
});
