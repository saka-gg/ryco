import type { ThreadGoal } from "@ryco/contracts";

import { isSlashCommandInput } from "./attachmentInstructionDelivery.ts";

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Leads the turn's input with the thread's active goal, for providers without native goals.
 * A slash command stays verbatim: provider CLIs only run input that starts with `/` as a
 * command, so the goal waits for the next ordinary turn.
 */
export function withProviderGoalPrompt(input: {
  readonly message: string | undefined;
  readonly goal: ThreadGoal | null | undefined;
}): string | undefined {
  if (input.goal?.status !== "active" || isSlashCommandInput(input.message)) {
    return input.message;
  }

  const goalContext = `<ryco_goal>
The user has set a persistent goal for this thread. Make concrete progress toward it while handling the current request. Keep the full objective in view across turns and clearly state when it is complete or genuinely blocked.

Objective: ${escapeXml(input.goal.objective)}
</ryco_goal>`;
  return input.message ? `${goalContext}\n\n${input.message}` : goalContext;
}
