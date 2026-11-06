import { CuaActionError } from "./CuaComputerBackend.ts";
import type { ComputerForegroundAuthorization } from "./computerVisibleUse.ts";

/**
 * The one check every foreground gate makes after the user's visible-use request: refuse
 * before dispatch when the desktop cannot take the foreground safely (no Escape stop).
 */
export function assertForegroundNotBlocked(
  authorization: ComputerForegroundAuthorization | undefined,
): void {
  const blocked = authorization?.blocked;
  if (blocked) throw new CuaActionError(blocked.message, "not-dispatched", blocked.code);
}
