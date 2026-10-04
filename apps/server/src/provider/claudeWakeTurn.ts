import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * Claude can start a turn without a prompt (a "wake"): background work finished, a schedule or
 * monitor fired, a rate limit lifted. These rules decide when such a provider turn opens and
 * which frames prove it is alive.
 */

/** Longest a wake-signal turn may stay open without any root output before it is aborted. */
export const CLAUDE_WAKE_TURN_FIRST_OUTPUT_TIMEOUT_MS = 120_000;
/** How long Stop waits for the CLI to end a provider turn before finishing it locally. */
export const CLAUDE_PROVIDER_TURN_STOP_GRACE_MS = 5_000;

export type ClaudeWakeSignal = "status" | "init";

function isRootFrame(message: SDKMessage): boolean {
  const parentToolUseId = (message as { readonly parent_tool_use_id?: string | null })
    .parent_tool_use_id;
  return parentToolUseId === null || parentToolUseId === undefined;
}

/**
 * Root system/status (requesting|compacting) → "status"; root system/init → "init"; else
 * undefined. A frame with a non-null parent_tool_use_id is never a signal.
 */
export function claudeWakeSignal(message: SDKMessage): ClaudeWakeSignal | undefined {
  if (message.type !== "system" || !isRootFrame(message)) {
    return undefined;
  }
  if (message.subtype === "status") {
    return message.status === "requesting" || message.status === "compacting"
      ? "status"
      : undefined;
  }
  return message.subtype === "init" ? "init" : undefined;
}

export interface ClaudeWakeTurnGate {
  readonly signal: ClaudeWakeSignal;
  readonly hasOpenTurn: boolean;
  readonly sessionStopped: boolean;
  /** A prompt turn was installed on this runtime; before that, signals are handshakes. */
  readonly promptSent: boolean;
  /** sendTurn calls between entry and install. */
  readonly turnInstallsInFlight: number;
  readonly requestingStatusObserved: boolean;
}

/**
 * Deny-list gate; "init" opens only when the CLI was never seen to emit `status: requesting`
 * (legacy CLIs). There is deliberately no allow list: every kind of wake is covered.
 */
export function shouldOpenClaudeWakeTurn(gate: ClaudeWakeTurnGate): boolean {
  if (
    gate.hasOpenTurn ||
    gate.sessionStopped ||
    !gate.promptSent ||
    gate.turnInstallsInFlight > 0
  ) {
    return false;
  }
  return gate.signal === "status" || !gate.requestingStatusObserved;
}

/**
 * Root frames that prove Claude is producing the current turn (watchdog liveness). A positive
 * list, so a future periodic background frame cannot keep a phantom turn alive.
 */
export function isClaudeRootTurnOutput(message: SDKMessage): boolean {
  if (!isRootFrame(message)) {
    return false;
  }
  switch (message.type) {
    case "stream_event":
    case "assistant":
    case "user":
    case "result":
      return true;
    case "system":
      switch (message.subtype) {
        case "compact_boundary":
        case "api_retry":
          return true;
        case "status":
          return message.status === "compacting";
        default:
          return false;
      }
    default:
      return false;
  }
}
