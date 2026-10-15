import type { TerminalEvent } from "@ryco/contracts";
import { MAX_TERMINALS_PER_GROUP } from "@ryco/client-runtime/state/threads";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  MAX_CACHED_TERMINAL_VIEWS,
  createTerminalViewCache,
  isTerminalEventIdSpaceReset,
  isTerminalViewCurrent,
  resolveTerminalViewCatchUp,
  terminalViewCacheKey,
} from "./terminalViewCache";

function fakeView(launchKey = "launch") {
  const element = { remove: vi.fn() } as unknown as HTMLElement;
  const terminal = { dispose: vi.fn() };
  return {
    view: {
      launchKey,
      terminal,
      element,
      state: {},
      lastAppliedTerminalEventId: 3,
      appliedCursor: { generation: "g1", sequence: 4 },
    },
    terminal,
    element,
  };
}

function entry(id: number, type: TerminalEvent["type"]): { id: number; event: TerminalEvent } {
  const base = { threadId: "thread", terminalId: "default", createdAt: "2026-10-12T00:00:00Z" };
  const event =
    type === "output"
      ? { ...base, type, data: `chunk-${id}` }
      : type === "exited"
        ? { ...base, type, exitCode: 0, exitSignal: null }
        : type === "error"
          ? { ...base, type, message: "boom" }
          : { ...base, type: "cleared" as const };
  return { id, event: event as TerminalEvent };
}

describe("createTerminalViewCache", () => {
  it("returns a stashed view once, for the same launch", () => {
    const cache = createTerminalViewCache<{ dispose(): void }, object>();
    const { view, terminal, element } = fakeView();
    const key = terminalViewCacheKey("env", "thread", "default");
    cache.stash(key, view);
    expect(element.remove).toHaveBeenCalledTimes(1);

    expect(cache.take(key, "launch")).toBe(view);
    expect(cache.take(key, "launch")).toBeNull();
    expect(terminal.dispose).not.toHaveBeenCalled();
  });

  it("disposes a view whose launch changed instead of reusing it", () => {
    const cache = createTerminalViewCache<{ dispose(): void }, object>();
    const { view, terminal } = fakeView("old-launch");
    cache.stash("key", view);
    expect(cache.take("key", "new-launch")).toBeNull();
    expect(terminal.dispose).toHaveBeenCalledTimes(1);
    expect(cache.size()).toBe(0);
  });

  it("disposes the least recently detached view beyond its bound", async () => {
    const cache = createTerminalViewCache<{ dispose(): void }, object>(2);
    const first = fakeView();
    const second = fakeView();
    const third = fakeView();
    cache.stash("first", first.view);
    cache.stash("second", second.view);
    cache.stash("third", third.view);
    await Promise.resolve();

    expect(cache.size()).toBe(2);
    expect(first.terminal.dispose).toHaveBeenCalledTimes(1);
    expect(second.terminal.dispose).not.toHaveBeenCalled();
    expect(cache.take("first", "launch")).toBeNull();
    expect(cache.take("third", "launch")).toBe(third.view);
  });

  it("serves views swapped back in by the same commit before applying its bound", async () => {
    // React runs all effect cleanups of a commit before its mounts, so a pane
    // focus swap stashes the outgoing views before the incoming ones are taken.
    const cache = createTerminalViewCache<{ dispose(): void }, object>(2);
    const incoming = [fakeView(), fakeView()];
    const outgoing = [fakeView(), fakeView()];
    incoming.forEach((item, index) => cache.stash(`in-${index}`, item.view));
    outgoing.forEach((item, index) => cache.stash(`out-${index}`, item.view));

    expect(cache.take("in-0", "launch")).toBe(incoming[0]!.view);
    expect(cache.take("in-1", "launch")).toBe(incoming[1]!.view);
    await Promise.resolve();

    expect(cache.size()).toBe(2);
    for (const item of [...incoming, ...outgoing]) {
      expect(item.terminal.dispose).not.toHaveBeenCalled();
    }
    expect(cache.take("out-0", "launch")).toBe(outgoing[0]!.view);
  });

  it("keeps every view of a full split group by default", async () => {
    const cache = createTerminalViewCache<{ dispose(): void }, object>();
    const group = Array.from({ length: MAX_TERMINALS_PER_GROUP }, () => fakeView());
    group.forEach((item, index) => cache.stash(`terminal-${index}`, item.view));
    await Promise.resolve();

    expect(MAX_CACHED_TERMINAL_VIEWS).toBeGreaterThanOrEqual(MAX_TERMINALS_PER_GROUP);
    group.forEach((item, index) => {
      expect(cache.take(`terminal-${index}`, "launch")).toBe(item.view);
      expect(item.terminal.dispose).not.toHaveBeenCalled();
    });
  });

  it("discards a view on request", () => {
    const cache = createTerminalViewCache<{ dispose(): void }, object>();
    const { view, terminal } = fakeView();
    cache.stash("key", view);
    cache.discard("key");
    expect(terminal.dispose).toHaveBeenCalledTimes(1);
    expect(cache.size()).toBe(0);
  });
});

describe("resolveTerminalViewCatchUp", () => {
  it("returns the events after the last applied one when the buffer still covers it", () => {
    const entries = [entry(3, "output"), entry(5, "output"), entry(9, "cleared")];
    expect(resolveTerminalViewCatchUp(entries, 3)?.map((item) => item.id)).toEqual([5, 9]);
    expect(resolveTerminalViewCatchUp(entries, 9)).toEqual([]);
  });

  it("refuses to catch up across events the buffer already dropped", () => {
    expect(resolveTerminalViewCatchUp([entry(7, "output")], 3)).toBeNull();
    expect(resolveTerminalViewCatchUp([entry(1, "output")], 0)).toBeNull();
  });

  it("has nothing to apply when no events arrived", () => {
    expect(resolveTerminalViewCatchUp([], 0)).toEqual([]);
    expect(resolveTerminalViewCatchUp([], 3)).toEqual([]);
  });

  it("hands an ended session to terminal.open, which restarts it", () => {
    expect(resolveTerminalViewCatchUp([entry(3, "output"), entry(4, "exited")], 3)).toBeNull();
    expect(resolveTerminalViewCatchUp([entry(3, "output"), entry(4, "error")], 3)).toBeNull();
  });

  it("hands a reconnect replay to terminal.open, since its output never reached the buffer", () => {
    const start = (replay: boolean): { id: number; event: TerminalEvent } => ({
      id: 4,
      event: {
        threadId: "thread",
        terminalId: "default",
        createdAt: "2026-10-12T00:00:00Z",
        type: "started",
        snapshot: {
          threadId: "thread",
          terminalId: "default",
          cwd: "/tmp",
          worktreePath: null,
          status: "running",
          pid: 1,
          history: "",
          exitCode: null,
          exitSignal: null,
          updatedAt: "2026-10-12T00:00:00Z",
        },
        ...(replay ? { replay: true as const } : {}),
      },
    });
    expect(
      resolveTerminalViewCatchUp([entry(3, "output"), start(true), entry(5, "output")], 3),
    ).toBeNull();
    // A live start carries its full snapshot, which the view applies itself.
    expect(resolveTerminalViewCatchUp([entry(3, "output"), start(false)], 3)).toHaveLength(1);
  });
});

describe("isTerminalViewCurrent", () => {
  it("is current only for the same generation at or behind the applied sequence", () => {
    const applied = { generation: "g1", sequence: 10 };
    expect(isTerminalViewCurrent({ generation: "g1", sequence: 10 }, applied)).toBe(true);
    expect(isTerminalViewCurrent({ generation: "g1", sequence: 9 }, applied)).toBe(true);
    expect(isTerminalViewCurrent({ generation: "g1", sequence: 11 }, applied)).toBe(false);
    expect(isTerminalViewCurrent({ generation: "g2", sequence: 1 }, applied)).toBe(false);
    expect(isTerminalViewCurrent(undefined, applied)).toBe(false);
    expect(isTerminalViewCurrent({ generation: "g1", sequence: 1 }, undefined)).toBe(false);
  });
});

describe("isTerminalEventIdSpaceReset", () => {
  it("detects only a counter that went backwards", () => {
    expect(isTerminalEventIdSpaceReset(501, 1)).toBe(true);
    expect(isTerminalEventIdSpaceReset(501, 502)).toBe(false);
    expect(isTerminalEventIdSpaceReset(1, 1)).toBe(false);
  });
});
