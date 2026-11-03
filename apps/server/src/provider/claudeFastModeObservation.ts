import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { type ClaudeFastModeReport, parseClaudeFastModeReport } from "@ryco/shared/claudeFastMode";

/**
 * Claude Code reports whether Fast mode actually serves requests on every init (one per CLI
 * turn) and every result. The adapter publishes that state as one latest-state activity per
 * thread, so the composer can say when the requested speed is not the one the account gets:
 * a connection Claude Code will not serve Fast on, a rate-limit cooldown, or Claude Code's own
 * settings turning Fast on while Ryco asked for Standard.
 */

/**
 * The Fast mode report of a root `result` or `system/init` frame; undefined for every other frame
 * and for a frame without a valid `fast_mode_state` (older CLIs omit it).
 */
export function readClaudeFastModeFrame(message: SDKMessage): ClaudeFastModeReport | undefined {
  if (message.type !== "result" && (message.type !== "system" || message.subtype !== "init")) {
    return undefined;
  }
  const parentToolUseId = (message as { readonly parent_tool_use_id?: string | null })
    .parent_tool_use_id;
  if (parentToolUseId !== null && parentToolUseId !== undefined) return undefined;
  return parseClaudeFastModeReport({
    state: message.fast_mode_state,
    disabledReason: message.fast_mode_disabled_reason,
  });
}

/**
 * Publishes when the state or reason moves. While the state contradicts the request (requested
 * Fast mode not serving, or Fast mode serving that Ryco did not request), it is also republished
 * on every result: clients load only the newest activities of a thread, and a long turn would
 * otherwise push the one report out of that window while the composer's notice still applies.
 * Which contradictions deserve a notice is the client's call (`classifyClaudeFastModeReport`).
 * The superseded copies are compacted from the event log (`latestStateActivities`).
 */
export function decideClaudeFastModePublish(input: {
  readonly previousSignature: string | undefined;
  readonly report: ClaudeFastModeReport;
  readonly isResult: boolean;
  /** Ryco asked this runtime for Fast mode. */
  readonly fastRequested: boolean;
}): { readonly publish: boolean; readonly signature: string } {
  const signature = `${input.report.state}:${input.report.disabledReason ?? ""}`;
  if (signature !== input.previousSignature) return { publish: true, signature };
  const contradicts = input.fastRequested !== (input.report.state === "on");
  return { publish: input.isResult && contradicts, signature };
}
