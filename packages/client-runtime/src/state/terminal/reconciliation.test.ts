import { describe, expect, it } from "vite-plus/test";
import type { TerminalEvent, TerminalSessionSnapshot } from "@ryco/contracts";
import { createTerminalEventReconciler, isTerminalEventAfterSnapshot } from "./reconciliation.ts";
import {
  createTerminalStateStore,
  selectTerminalEventEntries,
  selectThreadTerminalState,
} from "./store.ts";
import { scopeThreadRef } from "../../scoped.ts";

const at = "2026-09-15T00:00:00.000Z";
const snapshot = (sequence = 1, generation = "server-a"): TerminalSessionSnapshot => ({
  threadId: "t",
  terminalId: "default",
  cwd: "/tmp",
  worktreePath: null,
  status: "running",
  pid: 1,
  history: "replay",
  exitCode: null,
  exitSignal: null,
  updatedAt: at,
  cursor: { generation, sequence },
});
const output = (sequence: number, data = "live", generation = "server-a"): TerminalEvent => ({
  threadId: "t",
  terminalId: "default",
  createdAt: at,
  type: "output",
  data,
  cursor: { generation, sequence },
});

describe("terminal cursor reconciliation", () => {
  it("rejects stale events before shared activity projection and native event consumption", () => {
    const store = createTerminalStateStore();
    const thread = scopeThreadRef("environment-a" as never, "t" as never);
    const send = (event: TerminalEvent) => store.getState().applyTerminalEvent(thread, event);
    send({ ...output(1), type: "started", snapshot: snapshot() });
    // Polling can complete before delivery of the preceding PTY chunk.
    send({ ...output(3), type: "activity", hasRunningSubprocess: true });
    send({ ...output(2), type: "exited", exitCode: 0, exitSignal: null });
    send(output(2, "must survive activity"));
    expect(
      selectTerminalEventEntries(store.getState().terminalEventEntriesByKey, thread, "default").at(
        -1,
      )?.event,
    ).toMatchObject({ data: "must survive activity" });
    send({ ...output(2), type: "activity", hasRunningSubprocess: false });
    expect(
      selectThreadTerminalState(store.getState().terminalStateByThreadKey, thread)
        .runningTerminalIds,
    ).toEqual(["default"]);
    send({ ...output(4), type: "exited", exitCode: 0, exitSignal: null });
    send({ ...output(3), type: "activity", hasRunningSubprocess: true });
    expect(
      selectThreadTerminalState(store.getState().terminalStateByThreadKey, thread)
        .runningTerminalIds,
    ).toEqual([]);
    send({ ...output(1, "", "server-b"), type: "started", snapshot: snapshot(1, "server-b") });
    send({ ...output(2, "", "server-b"), type: "activity", hasRunningSubprocess: true });
    const count = store.getState().nextTerminalEventId;
    send(output(99, "stale", "server-a"));
    send({ ...output(100), type: "exited", exitCode: 0, exitSignal: null });
    send({ ...output(101), type: "activity", hasRunningSubprocess: false });
    expect(store.getState().nextTerminalEventId).toBe(count);
    expect(
      selectThreadTerminalState(store.getState().terminalStateByThreadKey, thread)
        .runningTerminalIds,
    ).toEqual(["default"]);
    store.getState().removeTerminalState(thread);
    expect(store.getState().terminalEventReconciliationByKey).toEqual({});
  });
  it("distinguishes included and fresh bytes in the same millisecond", () => {
    expect(isTerminalEventAfterSnapshot(output(1), snapshot())).toBe(false);
    expect(isTerminalEventAfterSnapshot(output(2), snapshot())).toBe(true);
    expect(isTerminalEventAfterSnapshot(output(9, "stale", "old-server"), snapshot())).toBe(false);
  });

  it("preserves the timestamp fallback for old servers", () => {
    const { cursor: _cursor, ...legacy } = snapshot();
    expect(isTerminalEventAfterSnapshot(output(2), legacy)).toBe(false);
    expect(
      isTerminalEventAfterSnapshot({ ...output(2), createdAt: "2026-09-15T00:00:00.001Z" }, legacy),
    ).toBe(true);
  });

  it("replays exact bytes once across reset, reconnect, generation change and exit", () => {
    const reconciler = createTerminalEventReconciler();
    reconciler.reset(snapshot());
    let bytes = "replay";
    const deliver = (event: TerminalEvent) => {
      if (!reconciler.accept(event)) return;
      if (event.type === "output") bytes += event.data;
      if (event.type === "cleared") bytes = "";
      if (event.type === "started" || event.type === "restarted") bytes = event.snapshot.history;
    };
    deliver(output(1, "duplicate"));
    deliver(output(2, "🙂\u001b[31mred\u001b[0m"));
    expect(bytes).toBe("replay🙂\u001b[31mred\u001b[0m");
    deliver({ ...output(3), type: "cleared" });
    deliver(output(2, "stale"));
    deliver(output(4, "after clear"));
    expect(bytes).toBe("after clear");
    const fresh = { ...snapshot(1, "server-b"), history: "restored" };
    deliver({ ...output(1, "", "server-b"), type: "started", snapshot: fresh });
    deliver(output(99, "old process", "server-a"));
    deliver(output(2, "tail", "server-b"));
    const exit: TerminalEvent = {
      ...output(3, "", "server-b"),
      type: "exited",
      exitCode: 0,
      exitSignal: null,
    };
    expect(reconciler.accept(exit)).toBe(true);
    expect(reconciler.accept(exit)).toBe(false);
    expect(bytes).toBe("restoredtail");
  });

  it("delivers the exit paired with a recovered exited snapshot exactly once", () => {
    const reconciler = createTerminalEventReconciler();
    reconciler.reset({ ...snapshot(5), status: "exited", pid: null, exitCode: 0 });
    const exit: TerminalEvent = { ...output(5), type: "exited", exitCode: 0, exitSignal: null };
    expect(reconciler.accept(exit)).toBe(true);
    expect(reconciler.accept(exit)).toBe(false);
  });
});
