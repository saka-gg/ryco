import { describe, expect, it } from "vite-plus/test";
import type { TerminalEvent, TerminalSessionSnapshot } from "@ryco/contracts";

import { scopeThreadRef, scopedThreadKey } from "../../scoped.ts";
import {
  createTerminalStateStore,
  selectTerminalEventEntries,
  selectThreadTerminalState,
  type TerminalStateStorage,
} from "./store.ts";

const thread = scopeThreadRef("environment-a" as never, "thread-1" as never);
const at = "2026-10-11T00:00:00.000Z";

const snapshot = (
  terminalId: string,
  sequence: number,
  overrides: Partial<TerminalSessionSnapshot> = {},
): TerminalSessionSnapshot => ({
  threadId: "thread-1",
  terminalId,
  cwd: "/repo",
  worktreePath: null,
  status: "running",
  pid: 42,
  history: "",
  exitCode: null,
  exitSignal: null,
  updatedAt: at,
  cursor: { generation: "server-a", sequence },
  ...overrides,
});

const started = (
  terminalId: string,
  sequence: number,
  extra: { replay?: true; hasRunningSubprocess?: boolean } = {},
): TerminalEvent => ({
  type: "started",
  threadId: "thread-1",
  terminalId,
  createdAt: at,
  cursor: { generation: "server-a", sequence },
  snapshot: snapshot(terminalId, sequence),
  ...extra,
});

const output = (terminalId: string, sequence: number): TerminalEvent => ({
  type: "output",
  threadId: "thread-1",
  terminalId,
  createdAt: at,
  cursor: { generation: "server-a", sequence },
  data: "x",
});

const terminalState = (store: ReturnType<typeof createTerminalStateStore>) =>
  selectThreadTerminalState(store.getState().terminalStateByThreadKey, thread);

describe("terminal store replay events", () => {
  it("keeps a closed drawer closed and the active terminal unchanged on replay", () => {
    const store = createTerminalStateStore();
    store.getState().applyTerminalEvent(thread, started("default", 1));
    store.getState().applyTerminalEvent(thread, started("split", 2));
    store.getState().setActiveTerminal(thread, "default");
    store.getState().setTerminalOpen(thread, false);
    const before = terminalState(store);

    // A reconnect replays every running session, least recently updated last.
    store
      .getState()
      .applyTerminalEvent(
        thread,
        started("default", 5, { replay: true, hasRunningSubprocess: true }),
      );
    store.getState().applyTerminalEvent(thread, started("split", 6, { replay: true }));

    const after = terminalState(store);
    expect(after.terminalOpen).toBe(false);
    expect(after.activeTerminalId).toBe("default");
    expect(after.activeTerminalGroupId).toBe(before.activeTerminalGroupId);
    expect(after.terminalIds).toEqual(["default", "split"]);
    expect(after.runningTerminalIds).toEqual(["default"]);
    expect(store.getState().terminalLaunchContextByThreadKey[scopedThreadKey(thread)]).toEqual({
      cwd: "/repo",
      worktreePath: null,
    });
  });

  it("registers a replayed terminal it did not know without opening or focusing it", () => {
    const store = createTerminalStateStore();
    store.getState().applyTerminalEvent(thread, started("background", 3, { replay: true }));

    const state = terminalState(store);
    expect(state.terminalOpen).toBe(false);
    expect(state.terminalIds).toEqual(["default", "background"]);
    expect(state.activeTerminalId).toBe("default");
  });

  it("still opens and focuses a terminal on a live start", () => {
    const store = createTerminalStateStore();
    store.getState().applyTerminalEvent(thread, started("setup", 1));

    const state = terminalState(store);
    expect(state.terminalOpen).toBe(true);
    expect(state.activeTerminalId).toBe("setup");
  });

  it("buffers a replay only when it proves output was missed", () => {
    const store = createTerminalStateStore();
    const entries = () =>
      selectTerminalEventEntries(store.getState().terminalEventEntriesByKey, thread, "default");
    store.getState().applyTerminalEvent(thread, started("default", 1));
    store.getState().applyTerminalEvent(thread, output("default", 2));

    // Nothing happened while disconnected: no entry, so a mounted drawer keeps its scrollback.
    store.getState().applyTerminalEvent(thread, started("default", 2, { replay: true }));
    expect(entries().map((entry) => entry.event.type)).toEqual(["started", "output"]);

    // Output was missed: the drawer sees the replay and re-hydrates through terminal.open.
    store.getState().applyTerminalEvent(thread, started("default", 9, { replay: true }));
    expect(entries().at(-1)?.event).toMatchObject({ type: "started", replay: true });
    expect(terminalState(store).terminalOpen).toBe(true);
  });
});

describe("terminal store persistence", () => {
  it("writes storage only when the persisted terminal state changes", () => {
    const writes: string[] = [];
    const storage: TerminalStateStorage = {
      getItem: () => null,
      setItem: (_name, value) => {
        writes.push(value);
      },
      removeItem: () => undefined,
    };
    const store = createTerminalStateStore({ storage });
    store.getState().applyTerminalEvent(thread, started("default", 1));
    const afterStart = writes.length;
    expect(afterStart).toBeGreaterThan(0);

    for (let sequence = 2; sequence < 12; sequence += 1) {
      store.getState().applyTerminalEvent(thread, output("default", sequence));
    }
    store.getState().recordTerminalEvent(thread, output("default", 12));
    expect(writes).toHaveLength(afterStart);

    store.getState().setTerminalHeight(thread, 321);
    expect(writes).toHaveLength(afterStart + 1);
    expect(JSON.parse(writes.at(-1)!).state.terminalStateByThreadKey).toMatchObject({
      [scopedThreadKey(thread)]: { terminalOpen: true, terminalHeight: 321 },
    });
  });
});
