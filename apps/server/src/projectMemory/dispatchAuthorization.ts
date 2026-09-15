import { ProjectMemoryError } from "@ryco/contracts";
import { Effect } from "effect";

interface Grant {
  readonly scope: object;
  readonly threadId: string;
  readonly projectId: string;
  readonly expiresAt: number;
  readonly authorize: Effect.Effect<void, ProjectMemoryError>;
}
const grants = new Map<string, Grant>();
const denied = () =>
  new ProjectMemoryError({
    reason: "unavailable",
    message:
      "Memory recall authorization expired. Reconnect and review the selection before sending again.",
  });
/** Only the existing authorized RPC scope can mint this transient grant. Restart/reconnect fails closed. */
export function registerMemoryDispatchAuthorization(
  commandId: string,
  grant: Omit<Grant, "expiresAt">,
) {
  return Effect.suspend(() => {
    const now = Date.now();
    for (const [id, entry] of grants) if (entry.expiresAt <= now) grants.delete(id);
    if (grants.has(commandId) || grants.size >= 1000) return Effect.fail(denied());
    grants.set(commandId, { ...grant, expiresAt: now + 3_600_000 });
    return Effect.void;
  });
}
export function revokeMemoryDispatchScope(scope: object): void {
  for (const [id, grant] of grants) if (grant.scope === scope) grants.delete(id);
}
export function takeMemoryDispatchAuthorization(
  commandId: string,
  threadId: string,
  projectId: string,
): Effect.Effect<void, ProjectMemoryError> {
  return Effect.suspend(() => {
    const grant = grants.get(commandId);
    if (
      !grant ||
      grant.threadId !== threadId ||
      grant.projectId !== projectId ||
      grant.expiresAt <= Date.now()
    )
      return Effect.fail(denied());
    return grant.authorize;
  });
}

export const forgetMemoryDispatchAuthorization = (commandId: string): void => {
  grants.delete(commandId);
};
