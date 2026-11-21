/**
 * Terminals an agent opened through `ryco_terminal` (ids `agent-<n>`): the same shells as any
 * other terminal of the thread, but started by the agent, so their start never opens or focuses
 * a drawer, and their tab reads "Agent <n>". Shared by the web drawer and the phone.
 *
 * @module state/terminal/agentTerminals
 */
import { AGENT_TERMINAL_ID_PREFIX } from "@ryco/contracts/terminal";

export const isAgentTerminalId = (terminalId: string): boolean =>
  terminalId.startsWith(AGENT_TERMINAL_ID_PREFIX);

/** "Agent 2" for `agent-2`; `null` for any other terminal. */
export function agentTerminalLabel(terminalId: string): string | null {
  if (!isAgentTerminalId(terminalId)) return null;
  const suffix = terminalId.slice(AGENT_TERMINAL_ID_PREFIX.length);
  return /^\d{1,4}$/.test(suffix) ? `Agent ${Number(suffix)}` : "Agent";
}

interface HandoffActivity {
  readonly kind: string;
  readonly payload: unknown;
}

const field = (payload: unknown, name: string): unknown =>
  payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>)[name]
    : undefined;

/**
 * The terminals an agent handed to the user that still wait for them (a pending terminal
 * `user-action.requested` without its `user-action.resolved`, not past its expiry): their tabs
 * show a marker. Reads only the fields it needs, without the payload schemas, so the chat and the
 * drawer can call it on every render.
 */
export function terminalsWaitingForUser(
  activities: ReadonlyArray<HandoffActivity>,
  nowMs: number,
): ReadonlyArray<string> {
  const resolved = new Set<string>();
  for (const activity of activities) {
    if (activity.kind !== "user-action.resolved") continue;
    const requestId = field(activity.payload, "requestId");
    if (typeof requestId === "string") resolved.add(requestId);
  }
  const waiting = new Set<string>();
  for (const activity of activities) {
    if (activity.kind !== "user-action.requested") continue;
    const { payload } = activity;
    const requestId = field(payload, "requestId");
    const target = field(payload, "target");
    const expiresAt = field(payload, "expiresAt");
    if (
      field(payload, "surface") !== "terminal" ||
      typeof requestId !== "string" ||
      typeof target !== "string" ||
      resolved.has(requestId) ||
      (typeof expiresAt === "string" && Date.parse(expiresAt) <= nowMs)
    ) {
      continue;
    }
    waiting.add(target);
  }
  return [...waiting];
}
