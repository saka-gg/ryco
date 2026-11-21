import { EnvironmentId, ThreadId } from "@ryco/contracts/base-schemas";

const MAX_ROUTE_ID_LENGTH = 256;
/** The node's terminal id limit. */
const MAX_TERMINAL_ID_LENGTH = 128;

function safeRouteId(value: unknown): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ROUTE_ID_LENGTH) return null;
  // oxlint-disable-next-line no-control-regex -- control characters are what it refuses
  return /[\u0000-\u001f\u007f]/u.test(trimmed) ? null : trimmed;
}

export interface TerminalRouteParams {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The terminal to show (a hand-off card's Show); absent, the thread's active one. */
  readonly terminalId: string | null;
}

export function parseTerminalRouteParams(value: unknown): TerminalRouteParams | null {
  if (!value || typeof value !== "object") return null;
  const params = value as Record<string, unknown>;
  const environmentId = safeRouteId(params.environmentId);
  const threadId = safeRouteId(params.threadId);
  if (!environmentId || !threadId) return null;
  const terminalId = safeRouteId(params.terminalId);
  return {
    environmentId: EnvironmentId.make(environmentId),
    threadId: ThreadId.make(threadId),
    terminalId:
      terminalId !== null && terminalId.length <= MAX_TERMINAL_ID_LENGTH ? terminalId : null,
  };
}
