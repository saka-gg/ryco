import { describe, expect, it } from "vite-plus/test";
import {
  TOOL_UPDATE_GATE_CAPACITY,
  TOOL_UPDATE_HEARTBEAT_MS,
  ToolUpdateGate,
  type ToolUpdateView,
  toolUpdateVisibleKey,
} from "./toolUpdateGate.ts";

const runningView: ToolUpdateView = {
  status: "running",
  title: "bash",
  detail: "Run tests",
  input: { command: "bun run test", description: "Run tests" },
  agentId: "opencode:session:child",
  turnId: "turn-1",
};
const running = (view: ToolUpdateView = runningView) => ({
  terminal: false,
  visibleKey: toolUpdateVisibleKey(view),
});
const terminal = { terminal: true, visibleKey: undefined };

describe("ToolUpdateGate", () => {
  it("emits a repeat of the same visible state at most once per heartbeat", () => {
    const heartbeatMs = 1_000;
    const gate = new ToolUpdateGate({ heartbeatMs });
    expect(gate.admit("call", running(), 0)).toBe(true);
    expect(gate.admit("call", running(), 1)).toBe(false);
    expect(gate.admit("call", running(), heartbeatMs - 1)).toBe(false);
    expect(gate.admit("call", running(), heartbeatMs)).toBe(true);
    // The heartbeat restarts from that emission.
    expect(gate.admit("call", running(), heartbeatMs + 1)).toBe(false);
    expect(gate.admit("call", running(), 2 * heartbeatMs - 1)).toBe(false);
    expect(gate.admit("call", running(), 2 * heartbeatMs)).toBe(true);
  });

  it("defaults to a 5 s heartbeat and 1,024 tracked items", () => {
    expect(TOOL_UPDATE_HEARTBEAT_MS).toBe(5_000);
    expect(TOOL_UPDATE_GATE_CAPACITY).toBe(1_024);
    const gate = new ToolUpdateGate();
    expect(gate.admit("call", running(), 0)).toBe(true);
    expect(gate.admit("call", running(), TOOL_UPDATE_HEARTBEAT_MS - 1)).toBe(false);
    expect(gate.admit("call", running(), TOOL_UPDATE_HEARTBEAT_MS)).toBe(true);
  });

  it.each([
    ["status", { status: "pending" }],
    ["title", { title: "Run the test suite" }],
    ["detail", { detail: "Run all tests" }],
    ["input", { input: { command: "bun run lint", description: "Run tests" } }],
    ["agentId", { agentId: "opencode:session:other" }],
    ["turnId", { turnId: "turn-2" }],
  ] as const)("emits a changed %s at once", (_field, change) => {
    const gate = new ToolUpdateGate();
    expect(gate.admit("call", running(), 0)).toBe(true);
    const changed = running({ ...runningView, ...change });
    expect(changed.visibleKey).not.toBe(running().visibleKey);
    expect(gate.admit("call", changed, 1)).toBe(true);
    // The changed state is now the one repeats are compared with.
    expect(gate.admit("call", changed, 2)).toBe(false);
    expect(gate.admit("call", running(), 3)).toBe(true);
  });

  it("emits every terminal update and forgets the item", () => {
    const gate = new ToolUpdateGate();
    expect(gate.admit("call", running(), 0)).toBe(true);
    expect(gate.size).toBe(1);
    expect(gate.admit("call", terminal, 1)).toBe(true);
    expect(gate.admit("call", terminal, 2)).toBe(true);
    expect(gate.size).toBe(0);
    // A late non-terminal update after the terminal one is a first sight, as before the gate.
    expect(gate.admit("call", running(), 3)).toBe(true);
  });

  it("emits when the clock steps backwards", () => {
    const gate = new ToolUpdateGate();
    expect(gate.admit("call", running(), 10_000)).toBe(true);
    expect(gate.admit("call", running(), 9_999)).toBe(true);
    // The backwards emission is the new reference.
    expect(gate.admit("call", running(), 10_000)).toBe(false);
  });

  it("forgets the least recently emitted item past its capacity", () => {
    const gate = new ToolUpdateGate({ capacity: 2 });
    expect(gate.admit("a", running(), 0)).toBe(true);
    expect(gate.admit("b", running(), 0)).toBe(true);
    expect(gate.admit("c", running(), 0)).toBe(true);
    expect(gate.size).toBe(2);
    // "a" was evicted, so it counts as new; "c" is still tracked.
    expect(gate.admit("a", running(), 1)).toBe(true);
    expect(gate.size).toBe(2);
    expect(gate.admit("c", running(), 1)).toBe(false);
    // Re-emitting "a" made "b" the oldest.
    expect(gate.admit("b", running(), 1)).toBe(true);
    expect(gate.size).toBe(2);
  });

  it("tracks items independently", () => {
    const gate = new ToolUpdateGate();
    expect(gate.admit("a", running(), 0)).toBe(true);
    expect(gate.admit("b", running(), 0)).toBe(true);
    expect(gate.admit("a", running(), 1)).toBe(false);
    expect(gate.admit("b", running(), 1)).toBe(false);
  });

  it("treats a forgotten item's next update as a first sight", () => {
    const gate = new ToolUpdateGate();
    expect(gate.admit("call", running(), 0)).toBe(true);
    gate.forget("call");
    expect(gate.size).toBe(0);
    expect(gate.admit("call", running(), 1)).toBe(true);
  });
});

describe("toolUpdateVisibleKey", () => {
  it("gives equal views equal keys", () => {
    expect(toolUpdateVisibleKey({ ...runningView })).toBe(toolUpdateVisibleKey(runningView));
    expect(
      toolUpdateVisibleKey({ status: "running", title: undefined, input: { command: "ls" } }),
    ).toBe(toolUpdateVisibleKey({ status: "running", input: { command: "ls" } }));
  });

  it("fails open on a view that does not serialise", () => {
    const cyclic: Record<string, unknown> = { command: "ls" };
    cyclic.self = cyclic;
    expect(toolUpdateVisibleKey({ status: "running", input: cyclic })).toBeUndefined();
    expect(toolUpdateVisibleKey({ status: "running", input: { size: 1n } })).toBeUndefined();

    // The gate emits an update it cannot compare and stops tracking the item, so the next
    // comparable update is a first sight.
    const gate = new ToolUpdateGate();
    const uncomparable = {
      terminal: false,
      visibleKey: toolUpdateVisibleKey({ status: "running", input: cyclic }),
    };
    expect(gate.admit("call", running(), 0)).toBe(true);
    for (let nowMs = 1; nowMs < 4; nowMs++) {
      expect(gate.admit("call", uncomparable, nowMs)).toBe(true);
      expect(gate.size).toBe(0);
    }
    expect(gate.admit("call", running(), 4)).toBe(true);
    expect(gate.admit("call", running(), 5)).toBe(false);
  });
});
