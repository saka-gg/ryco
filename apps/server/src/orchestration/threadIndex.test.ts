import { describe, expect, it } from "vitest";

import { findThreadInArray, updateThreadInArray } from "./threadIndex.ts";

describe("threadIndex", () => {
  const threads = [
    { id: "a", value: 1 },
    { id: "b", value: 2 },
    { id: "a", value: 3 },
  ];

  it("finds like Array.prototype.find, first occurrence first", () => {
    expect(findThreadInArray(threads, "a")).toBe(threads[0]);
    expect(findThreadInArray(threads, "b")).toBe(threads[1]);
    expect(findThreadInArray(threads, "missing")).toBeUndefined();
  });

  it("updates one thread into a new array and keeps lookups correct", () => {
    const next = updateThreadInArray(threads, "b", (thread) => ({ ...thread, value: 20 }));
    expect(next).not.toBe(threads);
    expect(next.map((thread) => thread.value)).toEqual([1, 20, 3]);
    expect(threads.map((thread) => thread.value)).toEqual([1, 2, 3]);
    expect(findThreadInArray(next, "b")?.value).toBe(20);
    expect(updateThreadInArray(next, "missing", (thread) => thread)).toBe(next);
  });

  it("rebuilds the index for arrays it has not seen", () => {
    const grown = [...threads, { id: "c", value: 4 }];
    expect(findThreadInArray(grown, "c")?.value).toBe(4);
    const shrunk = grown.filter((thread) => thread.id !== "b");
    expect(findThreadInArray(shrunk, "c")?.value).toBe(4);
    expect(findThreadInArray(shrunk, "b")).toBeUndefined();
  });
});
