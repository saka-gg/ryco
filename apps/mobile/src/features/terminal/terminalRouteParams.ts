import { EnvironmentId, ThreadId } from "@ryco/contracts/base-schemas";

const MAX_ROUTE_ID_LENGTH = 256;

function safeRouteId(value: unknown): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ROUTE_ID_LENGTH) return null;
  return /[\u0000-\u001f\u007f]/u.test(trimmed) ? null : trimmed;
}

export interface TerminalRouteParams {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

export function parseTerminalRouteParams(value: unknown): TerminalRouteParams | null {
  if (!value || typeof value !== "object") return null;
  const params = value as Record<string, unknown>;
  const environmentId = safeRouteId(params.environmentId);
  const threadId = safeRouteId(params.threadId);
  if (!environmentId || !threadId) return null;
  return { environmentId: EnvironmentId.make(environmentId), threadId: ThreadId.make(threadId) };
}
