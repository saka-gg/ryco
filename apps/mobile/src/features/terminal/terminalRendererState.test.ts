import { describe, expect, it } from "vite-plus/test";

import {
  acknowledgeTerminalRendererOutput,
  clampTerminalDimensions,
  initialTerminalRendererOutputState,
  queueTerminalRendererOutput,
  resetTerminalRendererOutput,
  TERMINAL_RENDERER_PENDING_HIGH_WATER_BYTES,
  terminalDimensionsChanged,
} from "./terminalRendererState";

describe("terminal renderer output state", () => {
  it("tracks ordered pending writes and acknowledgements by UTF-8 bytes", () => {
    const first = queueTerminalRendererOutput(initialTerminalRendererOutputState(), "one");
    expect(first.kind).toBe("write");
    const second = queueTerminalRendererOutput(first.state, "😀");
    expect(first.kind === "write" && first.sequence).toBe(1);
    expect(second.kind === "write" && second.sequence).toBe(2);
    expect(second.state.pendingBytes).toBe(7);
    expect(acknowledgeTerminalRendererOutput(second.state, 1).pendingBytes).toBe(4);
    expect(acknowledgeTerminalRendererOutput(second.state, 9)).toBe(second.state);
    expect(queueTerminalRendererOutput(second.state, "").kind).toBe("empty");
  });

  it("overflows at the high-water mark without reusing a sequence", () => {
    const state = {
      ...initialTerminalRendererOutputState(),
      nextSequence: 40,
      pendingBytes: TERMINAL_RENDERER_PENDING_HIGH_WATER_BYTES,
    };
    const next = queueTerminalRendererOutput(state, "x");
    expect(next).toEqual({
      kind: "overflow",
      state: { nextSequence: 40, pendingBySequence: {}, pendingBytes: 0 },
    });
    // A late acknowledgement for a write before the reset matches nothing.
    const after = queueTerminalRendererOutput(resetTerminalRendererOutput(state), "y");
    expect(after.kind === "write" && after.sequence).toBe(40);
  });

  it("clamps and deduplicates terminal dimensions", () => {
    expect(clampTerminalDimensions({ cols: 0.5, rows: 900 })).toEqual({ cols: 1, rows: 500 });
    expect(terminalDimensionsChanged({ cols: 80, rows: 24 }, { cols: 80.9, rows: 24.1 })).toBe(
      false,
    );
    expect(terminalDimensionsChanged({ cols: 80, rows: 24 }, { cols: 81, rows: 24 })).toBe(true);
    expect(terminalDimensionsChanged(null, { cols: 80, rows: 24 })).toBe(true);
  });
});
