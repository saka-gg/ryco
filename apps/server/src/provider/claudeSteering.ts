import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * Claude active-turn steering rules. A steer is an SDK user message offered with
 * `priority: "now"` and its own uuid while a Ryco turn runs. The CLI either folds it into the
 * running CLI turn or aborts that turn and runs it as the next one. The Ryco turn keeps its id
 * and absorbs every CLI segment until no accepted steer is pending, so these rules decide which
 * results belong to a turn, when a turn waits for a steer's segment instead of completing, and
 * what Stop does with steers the CLI still holds.
 *
 * Pure module: no Effect services, no I/O.
 */

/** The interrupt control response carries `still_queued` (and `cancelled`). Steering requires it. */
export const CLAUDE_CLI_CAPABILITY_INTERRUPT_RECEIPT = "interrupt_receipt_v1";
/** The interrupt control request honours `cancel_queued: true`. */
export const CLAUDE_CLI_CAPABILITY_INTERRUPT_CANCEL_QUEUED = "interrupt_cancel_queued_v1";
/** Bound for the per-session set of steer uuids Stop cancelled but the CLI may still run. */
export const CLAUDE_DISCARDED_STEER_CAP = 64;

const ABORT_TERMINAL_REASONS: ReadonlySet<string> = new Set(["aborted_streaming", "aborted_tools"]);

export function resultErrorsText(result: SDKResultMessage): string {
  return "errors" in result && Array.isArray(result.errors)
    ? result.errors.join(" ").toLowerCase()
    : "";
}

export function isInterruptedResult(result: SDKResultMessage): boolean {
  const errors = resultErrorsText(result);
  if (errors.includes("interrupt")) {
    return true;
  }

  return (
    result.subtype === "error_during_execution" &&
    result.is_error === false &&
    (errors.includes("request was aborted") ||
      errors.includes("interrupted by user") ||
      errors.includes("aborted"))
  );
}

/** The CLI ended the segment by aborting it (a Stop or a `priority: "now"` steer). */
export function isClaudeAbortTerminalReason(result: SDKResultMessage): boolean {
  const terminalReason = Reflect.get(result, "terminal_reason");
  return typeof terminalReason === "string" && ABORT_TERMINAL_REASONS.has(terminalReason);
}

function readStringArray(value: unknown): ReadonlyArray<string> | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? (value as ReadonlyArray<string>)
    : undefined;
}

function isRootFrame(message: SDKMessage): boolean {
  const parentToolUseId = Reflect.get(message, "parent_tool_use_id");
  return parentToolUseId === null || parentToolUseId === undefined;
}

/**
 * The prompt uuids a frame echoes. Results echo every user message the CLI turn consumed. The
 * CLI turn's first reply frame echoes the messages that started it (early echo): its first
 * non-ping stream event, or its first root assistant message when it streamed nothing (a request
 * that failed at the API replies with a synthetic error message).
 */
export function claudeEchoedPromptUuids(message: SDKMessage): ReadonlyArray<string> {
  if (
    message.type !== "result" &&
    message.type !== "stream_event" &&
    !(message.type === "assistant" && isRootFrame(message))
  ) {
    return [];
  }
  const uuids = readStringArray(Reflect.get(message, "user_message_uuids"));
  if (uuids !== undefined && uuids.length > 0) return uuids;
  const uuid = Reflect.get(message, "user_message_uuid");
  return typeof uuid === "string" && uuid.length > 0 ? [uuid] : [];
}

export type ClaudeResultKind = "success" | "abort" | "failure";

export function classifyClaudeResultKind(result: SDKResultMessage): ClaudeResultKind {
  if (result.subtype === "success" && !result.is_error) return "success";
  if (isClaudeAbortTerminalReason(result)) return "abort";
  if (Reflect.get(result, "terminal_reason") === undefined && isInterruptedResult(result)) {
    return "abort";
  }
  return "failure";
}

/** Whether an echo names the turn's prompt or one of its steers. */
export function claudeEchoNamesTurn(input: {
  readonly echoed: ReadonlyArray<string>;
  readonly promptUuid: string | undefined;
  readonly steerPromptUuids: ReadonlySet<string>;
}): boolean {
  return input.echoed.some((uuid) => uuid === input.promptUuid || input.steerPromptUuids.has(uuid));
}

/**
 * Whether a result belongs to the open prompt turn. It does when it echoes the prompt or any of
 * the turn's steers. Without an echo (older CLIs) it belongs unless its origin is not human.
 * Callers skip the check for provider turns (no prompt uuid).
 */
export function claudeResultBelongsToTurn(input: {
  readonly echoed: ReadonlyArray<string>;
  readonly origin: { readonly kind: string } | undefined;
  readonly promptUuid: string;
  readonly steerPromptUuids: ReadonlySet<string>;
}): boolean {
  if (input.echoed.length > 0) return claudeEchoNamesTurn(input);
  return input.origin === undefined || input.origin.kind === "human";
}

export interface ClaudeTurnResultDecisionInput {
  readonly kind: ClaudeResultKind;
  readonly echoedPromptUuids: ReadonlyArray<string>;
  readonly queuedTurnCount: number | undefined;
  readonly steerPromptUuids: ReadonlySet<string>;
  readonly settledSteerPromptUuids: ReadonlySet<string>;
  readonly interruptRequested: boolean;
}

export interface ClaudeTurnResultDecision {
  /** `await-steer`: seal this segment and keep the turn open for the steer's CLI turn. */
  readonly decision: "complete" | "await-steer";
  /** Steers this result consumed for the first time. */
  readonly newlySettled: ReadonlyArray<string>;
  /** Steers no result has consumed yet, after this one. */
  readonly unsettled: ReadonlyArray<string>;
  /**
   * Completing: the unsettled steers must never reply, so their CLI turn is dropped when it
   * runs. Stop was requested, or the segment failed.
   */
  readonly discardUnsettled: boolean;
  /**
   * Completing: no Stop, yet the segment aborted while a steer was pending, so the steer aborted
   * it. The turn completes as `completed` (a steer is never an interrupt) and the steer runs as
   * Claude's next request, whose reply lands in a background turn.
   */
  readonly abortedBySteer: boolean;
}

/**
 * The turn waits only when Stop was not requested, a steer is still unsettled, the segment ended
 * by abort or success, and the CLI positively promised another result (`queued_turn_count > 0`).
 * Every other result completes the turn, so no waiting is unbounded.
 */
export function decideClaudeTurnResult(
  input: ClaudeTurnResultDecisionInput,
): ClaudeTurnResultDecision {
  const echoed = new Set(input.echoedPromptUuids);
  const newlySettled: Array<string> = [];
  const unsettled: Array<string> = [];
  for (const uuid of input.steerPromptUuids) {
    if (input.settledSteerPromptUuids.has(uuid)) continue;
    if (echoed.has(uuid)) newlySettled.push(uuid);
    else unsettled.push(uuid);
  }
  const awaitSteer =
    !input.interruptRequested &&
    unsettled.length > 0 &&
    (input.kind === "abort" || input.kind === "success") &&
    typeof input.queuedTurnCount === "number" &&
    input.queuedTurnCount > 0;
  const completingWithSteers = !awaitSteer && unsettled.length > 0;
  return {
    decision: awaitSteer ? "await-steer" : "complete",
    newlySettled,
    unsettled,
    discardUnsettled:
      completingWithSteers && (input.interruptRequested || input.kind === "failure"),
    abortedBySteer: completingWithSteers && !input.interruptRequested && input.kind === "abort",
  };
}

export interface ClaudeInterruptReceipt {
  /** Uuids that survive the interrupt and will still run unless cancelled. */
  readonly stillQueued: ReadonlyArray<string>;
  /** Present only when the interrupt asked to cancel queued messages. */
  readonly cancelled: ReadonlyArray<string> | undefined;
}

/** Defensive: anything but a `still_queued` string array is "no receipt" (older CLIs). */
export function readClaudeInterruptReceipt(value: unknown): ClaudeInterruptReceipt | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const stillQueued = readStringArray(Reflect.get(value, "still_queued"));
  if (stillQueued === undefined) return undefined;
  return { stillQueued, cancelled: readStringArray(Reflect.get(value, "cancelled")) };
}

export interface ClaudeStopDecisionInput {
  readonly unsettledSteers: ReadonlyArray<string>;
  /**
   * Steers whose CLI segment already streamed into the turn. They are running whatever the
   * receipt says: the receipt was written before they started, and handled after.
   */
  readonly startedSteers: ReadonlySet<string>;
  readonly promptUuid: string | undefined;
  /** Segments this turn already sealed while waiting for a steer. */
  readonly sealedSegmentCount: number;
  readonly awaitingSteerContinuation: boolean;
  readonly receipt: ClaudeInterruptReceipt | undefined;
}

export interface ClaudeStopDecision {
  /**
   * Close the turn now: no CLI turn of it is running, so no result will close it. Applies only
   * while the stopped turn is still open.
   */
  readonly forceClose: boolean;
  /** Steer uuids the CLI may still run; their CLI turn is interrupted and dropped. */
  readonly discard: ReadonlyArray<string>;
  /**
   * Steers the interrupt cancelled: they never run, so they leave the discard set and count as
   * settled, so a result handled after the receipt cannot discard them again. A result handled
   * before the receipt may already have put them there.
   */
  readonly release: ReadonlyArray<string>;
}

/**
 * Stop with steers pending. A steer that already streamed into the turn, or that the receipt
 * does not list as queued or cancelled (in transit), counts as running, so its own aborted
 * result closes the turn. The discard and release lists hold whether or not the stopped turn is
 * still open.
 */
export function decideClaudeStop(input: ClaudeStopDecisionInput): ClaudeStopDecision {
  if (input.receipt === undefined) {
    return {
      forceClose: input.awaitingSteerContinuation,
      discard: [...input.unsettledSteers],
      release: [],
    };
  }
  const cancelled = new Set(input.receipt.cancelled ?? []);
  const outstanding = new Set([...input.receipt.stillQueued, ...cancelled]);
  const runningSteers = input.unsettledSteers.filter(
    (uuid) => input.startedSteers.has(uuid) || !outstanding.has(uuid),
  );
  const isReleased = (uuid: string) => cancelled.has(uuid) && !input.startedSteers.has(uuid);
  const promptDone =
    input.sealedSegmentCount > 0 ||
    (input.promptUuid !== undefined && cancelled.has(input.promptUuid));
  return {
    forceClose: promptDone && runningSteers.length === 0,
    discard: input.unsettledSteers.filter((uuid) => !isReleased(uuid)),
    release: input.unsettledSteers.filter(isReleased),
  };
}

/** FIFO-bounded insert. */
export function rememberDiscardedSteer(
  set: Set<string>,
  uuid: string,
  cap: number = CLAUDE_DISCARDED_STEER_CAP,
): void {
  if (set.has(uuid)) return;
  while (set.size >= cap) {
    const oldest = set.values().next();
    if (oldest.done) break;
    set.delete(oldest.value);
  }
  set.add(uuid);
}

/** Capabilities a CLI advertises on `system/init`; empty when the field is absent. */
export function parseClaudeCliCapabilities(initMessage: SDKMessage): ReadonlySet<string> {
  const capabilities = Reflect.get(initMessage, "capabilities");
  return new Set(
    Array.isArray(capabilities)
      ? capabilities.filter((entry): entry is string => typeof entry === "string")
      : [],
  );
}

/**
 * Root model-turn content frames: a CLI segment's output, as opposed to system, subagent or
 * keep-alive frames. A CLI turn's first such frame carries its echo: a stream event, or the
 * assistant message when nothing streamed. System frames (`api_retry`, compaction) carry no
 * echo, so they never qualify.
 */
export function isClaudeRootTurnFrame(message: SDKMessage): boolean {
  if (message.type !== "stream_event" && message.type !== "assistant" && message.type !== "user") {
    return false;
  }
  if (message.type === "stream_event") {
    const event: unknown = Reflect.get(message, "event");
    if (typeof event === "object" && event !== null && Reflect.get(event, "type") === "ping") {
      return false;
    }
  }
  return isRootFrame(message);
}

/**
 * A synthetic API-error reply: the request failed after its retries and the CLI turn ends with
 * the next result, so interrupting it again could only reach whatever the CLI runs next.
 * `max_output_tokens` is excluded because the CLI can continue that turn.
 */
export function isClaudeApiErrorReply(message: SDKMessage): boolean {
  if (message.type !== "assistant") return false;
  const error = Reflect.get(message, "error");
  return typeof error === "string" && error !== "max_output_tokens";
}
