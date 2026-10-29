import type { ThreadTokenUsageSnapshot } from "@ryco/contracts";

export const CONTEXT_COMPACTION_TRIGGER_RATIO = 0.8;
export const CONTEXT_COMPACTION_REARM_RATIO = 0.65;

export type ContextCompactionPhase = "idle" | "requested" | "compacting" | "disabled";

export interface ContextCompactionPolicyState {
  readonly generation: number;
  readonly phase: ContextCompactionPhase;
  readonly armed: boolean;
  /** The prompt uuid of the native compaction a trigger sent, until that prompt's result. */
  readonly requestId?: string;
}

export interface ContextCompactionDecision {
  readonly state: ContextCompactionPolicyState;
  readonly trigger: boolean;
}

export interface ContextCompactionConclusion {
  readonly state: ContextCompactionPolicyState;
  /** The request ended without compacting: automatic compaction is unavailable. */
  readonly unavailable: boolean;
}

/**
 * Claude Code auto-compacts on its own once the context reaches its auto-compact window minus this
 * reserve: up to 20,000 tokens for the reply and a 13,000-token buffer. The opt-in probe
 * (claudeCompactionCliProbe.test.ts) checks it against the pinned CLI.
 */
export const NATIVE_AUTO_COMPACT_RESERVE_TOKENS = 33_000;

/**
 * How far at least Claude Code's own threshold stays above the trigger under a configured window:
 * as far as on a 200,000-token model by default (167,000 against 160,000).
 */
export const NATIVE_AUTO_COMPACT_MIN_LEAD_TOKENS = 7_000;

/**
 * The auto-compact window to start Claude Code with while this policy compacts within
 * `windowTokens`. Claude Code compacts in the middle of a turn, so its threshold has to stay above
 * the between-turn trigger or it would compact first: below 200,000 tokens the window it gets is
 * raised until its threshold is that lead above 80% of `windowTokens`. The policy itself keeps
 * using `windowTokens`, and the result never exceeds 1,000,000 for a window that does not.
 */
export function nativeAutoCompactWindowBehindTrigger(windowTokens: number): number {
  return Math.max(
    windowTokens,
    Math.ceil(windowTokens * CONTEXT_COMPACTION_TRIGGER_RATIO) +
      NATIVE_AUTO_COMPACT_RESERVE_TOKENS +
      NATIVE_AUTO_COMPACT_MIN_LEAD_TOKENS,
  );
}

const isUsableWindow = (tokens: number | undefined): tokens is number =>
  tokens !== undefined && Number.isFinite(tokens) && tokens > 0;

/** The smaller usable window of the two, or undefined when neither is usable. */
function effectiveCompactionWindow(
  reported: number | undefined,
  configured: number | undefined,
): number | undefined {
  if (!isUsableWindow(configured)) return reported;
  if (!isUsableWindow(reported)) return configured;
  return Math.min(reported, configured);
}

export function initialContextCompactionPolicyState(
  generation: number,
): ContextCompactionPolicyState {
  return {
    generation,
    phase: "idle",
    armed: true,
  };
}

/**
 * Decides whether a context snapshot should arm automatic compaction.
 *
 * The lower rearm watermark prevents a repeated high-water snapshot from
 * creating another request after a completed or interrupted compaction. A
 * generation mismatch is always ignored so a late observation from a replaced
 * provider session cannot mutate the active one.
 *
 * Both ratios apply to the smaller of the reported window and `windowTokens`
 * (a configured compaction window), whichever of them is known.
 */
export function observeContextCompaction(
  state: ContextCompactionPolicyState,
  input: {
    readonly generation: number;
    readonly usage: ThreadTokenUsageSnapshot;
    readonly windowTokens?: number | undefined;
  },
): ContextCompactionDecision {
  if (input.generation !== state.generation || state.phase === "disabled") {
    return { state, trigger: false };
  }

  const { usedTokens } = input.usage;
  const maxTokens = effectiveCompactionWindow(input.usage.maxTokens, input.windowTokens);
  if (
    maxTokens === undefined ||
    !Number.isFinite(maxTokens) ||
    maxTokens <= 0 ||
    !Number.isFinite(usedTokens) ||
    usedTokens < 0
  ) {
    return { state, trigger: false };
  }

  const ratio = usedTokens / maxTokens;
  if (state.phase !== "idle") {
    return { state, trigger: false };
  }
  if (!state.armed) {
    return ratio <= CONTEXT_COMPACTION_REARM_RATIO
      ? { state: { ...state, armed: true }, trigger: false }
      : { state, trigger: false };
  }
  if (ratio < CONTEXT_COMPACTION_TRIGGER_RATIO) {
    return { state, trigger: false };
  }

  return {
    state: {
      ...state,
      phase: "requested",
      armed: false,
    },
    trigger: true,
  };
}

/** Binds a triggered request to the native compaction prompt sent for it. */
export function recordContextCompactionRequest(
  state: ContextCompactionPolicyState,
  generation: number,
  requestId: string,
): ContextCompactionPolicyState {
  if (generation !== state.generation || state.phase !== "requested") return state;
  return { ...state, requestId };
}

/**
 * Concludes a request at the result of its compaction prompt. Only a compaction boundary (or a
 * successful compaction status) settles a request, so one still open at its result never
 * compacted: Claude reports a refused `/compact` as a successful result. A stopped request (or
 * one whose turn closed before its result) settles quietly; the rearm watermark keeps it from
 * repeating.
 */
export function concludeContextCompactionRequest(
  state: ContextCompactionPolicyState,
  input: {
    readonly generation: number;
    readonly requestId: string;
    readonly aborted: boolean;
  },
): ContextCompactionConclusion {
  if (input.generation !== state.generation || state.requestId !== input.requestId) {
    return { state, unavailable: false };
  }
  const { requestId: _requestId, ...concluded } = state;
  if (concluded.phase !== "requested" && concluded.phase !== "compacting") {
    return { state: concluded, unavailable: false };
  }
  return input.aborted
    ? { state: { ...concluded, phase: "idle", armed: false }, unavailable: false }
    : { state: { ...concluded, phase: "disabled", armed: false }, unavailable: true };
}

export function markContextCompactionStarted(
  state: ContextCompactionPolicyState,
  generation: number,
): ContextCompactionPolicyState {
  if (generation !== state.generation || state.phase === "disabled") return state;
  return { ...state, phase: "compacting", armed: false };
}

export function settleContextCompaction(
  state: ContextCompactionPolicyState,
  generation: number,
): ContextCompactionPolicyState {
  if (generation !== state.generation || state.phase === "disabled") return state;
  return {
    ...state,
    phase: "idle",
    armed: false,
  };
}

export function disableContextCompaction(
  state: ContextCompactionPolicyState,
  generation: number,
): ContextCompactionPolicyState {
  if (generation !== state.generation) return state;
  return {
    ...state,
    phase: "disabled",
    armed: false,
  };
}
