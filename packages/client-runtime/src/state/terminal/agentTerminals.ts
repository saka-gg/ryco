/**
 * Terminals an agent opened through `ryco_terminal` (ids `agent-<n>`): the same shells as any
 * other terminal of the thread, but started by the agent, so their start never opens or focuses
 * a drawer, and their tab reads "Agent <n>". Shared by the web drawer and the phone.
 *
 * @module state/terminal/agentTerminals
 */
import { AGENT_TERMINAL_ID_PREFIX } from "@ryco/contracts/terminal";
import { pendingUserActionTargets } from "@ryco/shared/threadActivity";

export const isAgentTerminalId = (terminalId: string): boolean =>
  terminalId.startsWith(AGENT_TERMINAL_ID_PREFIX);

/** "Agent 2" for `agent-2`; `null` for any other terminal. */
export function agentTerminalLabel(terminalId: string): string | null {
  if (!isAgentTerminalId(terminalId)) return null;
  const suffix = terminalId.slice(AGENT_TERMINAL_ID_PREFIX.length);
  return /^\d{1,4}$/.test(suffix) ? `Agent ${Number(suffix)}` : "Agent";
}

/**
 * The terminals an agent handed to the user that still wait for them: their tabs show a marker.
 * The pending rule is the shared one (`pendingUserActionTargets`).
 */
export function terminalsWaitingForUser(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
  nowMs: number,
): ReadonlyArray<string> {
  return pendingUserActionTargets(activities, nowMs, "terminal").filter((target) => target !== "");
}
