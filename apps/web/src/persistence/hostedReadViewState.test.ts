import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  configureHostedReadViewState,
  hostedScrollPositions,
  readHostedThreadScroll,
  saveHostedThreadScroll,
} from "./hostedReadViewState";

afterEach(() => {
  configureHostedReadViewState(null);
  hostedScrollPositions.clear();
});

describe("saveHostedThreadScroll", () => {
  it("saves only a changed position", () => {
    const changed = vi.fn();
    configureHostedReadViewState(changed);

    saveHostedThreadScroll("thread-a", 120);
    saveHostedThreadScroll("thread-a", 120);
    expect(changed).toHaveBeenCalledOnce();

    saveHostedThreadScroll("thread-a", 240);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(readHostedThreadScroll("thread-a")).toBe(240);
  });

  it("keeps a thread revisited at the same position as recently used", () => {
    configureHostedReadViewState(() => undefined);
    for (let index = 0; index < 64; index += 1) saveHostedThreadScroll(`thread-${index}`, index);

    // Revisited at the same offset: no save, but no longer the oldest entry.
    saveHostedThreadScroll("thread-0", 0);
    saveHostedThreadScroll("thread-64", 64);

    expect(readHostedThreadScroll("thread-0")).toBe(0);
    expect(readHostedThreadScroll("thread-1")).toBeUndefined();
  });
});
