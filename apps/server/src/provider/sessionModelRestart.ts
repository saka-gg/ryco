import type { ModelSelection } from "@ryco/contracts";
import { Equal } from "effect";

/**
 * Claude options the live session applies at the next turn instead of restarting. Fast mode is a
 * flag setting Claude Code takes mid-session (`applyFlagSettings`), as its own `/fast` toggle
 * does; the Claude adapter applies it in `sendTurn`.
 */
const CLAUDE_IN_SESSION_OPTION_IDS: ReadonlySet<string> = new Set(["fastMode"]);

function withoutClaudeInSessionOptions(selection: ModelSelection): ModelSelection {
  return {
    instanceId: selection.instanceId,
    model: selection.model,
    options: (selection.options ?? []).filter(
      (option) => !CLAUDE_IN_SESSION_OPTION_IDS.has(option.id),
    ),
  };
}

/**
 * Whether a turn's model selection restarts the thread's live session on its provider
 * instance. A Claude session restarts (resuming its conversation) for any change of model or
 * options except those it applies in-session (`CLAUDE_IN_SESSION_OPTION_IDS`); every other
 * driver applies the selection inside the running session. The restart replaces the provider
 * runtime, which ends the native background work it still runs, so the engine guards such a
 * turn start like a context handoff (`requireNoBackgroundWorkForModelSwitch`).
 */
export function modelSelectionChangeRestartsSession(input: {
  readonly driver: string | null | undefined;
  readonly previous: ModelSelection | undefined;
  readonly requested: ModelSelection | undefined;
}): boolean {
  if (input.driver !== "claudeAgent" || input.requested === undefined) return false;
  if (input.previous === undefined) return true;
  return !Equal.equals(
    withoutClaudeInSessionOptions(input.previous),
    withoutClaudeInSessionOptions(input.requested),
  );
}
