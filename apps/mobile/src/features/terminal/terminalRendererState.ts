import { utf8ByteLength } from "./terminalBridgeProtocol";

/**
 * Output posted to a renderer terminal but not yet acknowledged as parsed. Past
 * this the controller stops posting and re-hydrates that terminal from a fresh
 * authoritative snapshot instead of losing or reordering output.
 */
export const TERMINAL_RENDERER_PENDING_HIGH_WATER_BYTES = 1024 * 1024;

export interface TerminalRendererOutputState {
  /** Monotonic for the surface's life, so an acknowledgement can never match a later write. */
  readonly nextSequence: number;
  readonly pendingBySequence: Readonly<Record<number, number>>;
  readonly pendingBytes: number;
}

export function initialTerminalRendererOutputState(): TerminalRendererOutputState {
  return { nextSequence: 1, pendingBySequence: {}, pendingBytes: 0 };
}

/** Forget pending writes (a re-hydration replaces them) without reusing their sequences. */
export function resetTerminalRendererOutput(
  state: TerminalRendererOutputState,
): TerminalRendererOutputState {
  return { nextSequence: state.nextSequence, pendingBySequence: {}, pendingBytes: 0 };
}

export type QueuedTerminalRendererOutput =
  | {
      readonly kind: "write";
      readonly state: TerminalRendererOutputState;
      readonly sequence: number;
    }
  | { readonly kind: "empty"; readonly state: TerminalRendererOutputState }
  | { readonly kind: "overflow"; readonly state: TerminalRendererOutputState };

export function queueTerminalRendererOutput(
  state: TerminalRendererOutputState,
  data: string,
): QueuedTerminalRendererOutput {
  const bytes = utf8ByteLength(data);
  if (bytes === 0) return { kind: "empty", state };
  if (state.pendingBytes + bytes > TERMINAL_RENDERER_PENDING_HIGH_WATER_BYTES) {
    return { kind: "overflow", state: resetTerminalRendererOutput(state) };
  }
  const sequence = state.nextSequence;
  return {
    kind: "write",
    sequence,
    state: {
      nextSequence: sequence + 1,
      pendingBySequence: { ...state.pendingBySequence, [sequence]: bytes },
      pendingBytes: state.pendingBytes + bytes,
    },
  };
}

export function acknowledgeTerminalRendererOutput(
  state: TerminalRendererOutputState,
  sequence: number,
): TerminalRendererOutputState {
  const bytes = state.pendingBySequence[sequence];
  if (bytes === undefined) return state;
  const { [sequence]: _removed, ...pendingBySequence } = state.pendingBySequence;
  return {
    ...state,
    pendingBySequence,
    pendingBytes: Math.max(0, state.pendingBytes - bytes),
  };
}

export interface TerminalDimensions {
  readonly cols: number;
  readonly rows: number;
}

/** The contract's bounds: 1..1000 columns and 1..500 rows. */
export function clampTerminalDimensions(input: TerminalDimensions): TerminalDimensions {
  return {
    cols: Math.min(1_000, Math.max(1, Math.trunc(input.cols))),
    rows: Math.min(500, Math.max(1, Math.trunc(input.rows))),
  };
}

export function terminalDimensionsChanged(
  previous: TerminalDimensions | null,
  next: TerminalDimensions,
): boolean {
  const clamped = clampTerminalDimensions(next);
  return previous === null || previous.cols !== clamped.cols || previous.rows !== clamped.rows;
}
