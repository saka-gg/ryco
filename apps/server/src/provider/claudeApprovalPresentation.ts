import { stripVTControlCharacters } from "node:util";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";

/**
 * What a Claude permission request adds to its approval card beyond the tool summary: the CLI's
 * own reason for asking, and whether it allows a session-wide grant.
 *
 * Pure module: no Effect services, no I/O.
 */
export interface ClaudeApprovalPresentation {
  readonly reason?: string;
  /** Set when accepting for the session would write a rule broader than this one action. */
  readonly acceptForSessionOffered?: false;
}

export function claudeApprovalPresentation(input: {
  /** The summary the approval already shows. */
  readonly detail: string;
  readonly options: Pick<
    Parameters<CanUseTool>[2],
    "decisionReason" | "title" | "suppressAlwaysAllowRule"
  >;
}): ClaudeApprovalPresentation {
  // The reason can carry terminal escapes from the CLI's own prompt renderer.
  const reason = stripVTControlCharacters(input.options.decisionReason ?? "").trim();
  const repeatsPrompt =
    reason === input.detail.trim() || reason === (input.options.title ?? "").trim();
  return {
    ...(reason !== "" && !repeatsPrompt ? { reason } : {}),
    ...(input.options.suppressAlwaysAllowRule === true ? { acceptForSessionOffered: false } : {}),
  };
}
