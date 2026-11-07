import { CuaActionError } from "./CuaComputerBackend.ts";
import {
  COMPUTER_FOREGROUND_NOT_REQUESTED_CODE,
  type ComputerForegroundAuthorization,
} from "./computerVisibleUse.ts";

/** The refusal for a foreground call in a task that may not come to the front. */
export function foregroundNotRequestedError(): CuaActionError {
  return new CuaActionError(
    "This task asked to stay in the background, or did not come from the user, so no window " +
      "may come to the front. Keep observing and acting through background input, or report " +
      "what cannot be done without the foreground.",
    "not-dispatched",
    COMPUTER_FOREGROUND_NOT_REQUESTED_CODE,
  );
}

/**
 * The refusal a foreground call gets before anything else (app approval included), or
 * undefined when the task may come to the front and the desktop can take it safely.
 */
export function foregroundGateRefusal(
  authorization: ComputerForegroundAuthorization | undefined,
): CuaActionError | undefined {
  if (authorization?.userRequestedVisibleUse !== true) return foregroundNotRequestedError();
  const blocked = authorization.blocked;
  return blocked ? new CuaActionError(blocked.message, "not-dispatched", blocked.code) : undefined;
}

/**
 * The one check every foreground gate makes once the task may come to the front: refuse
 * before dispatch when the desktop cannot take the foreground safely (no Escape stop).
 */
export function assertForegroundNotBlocked(
  authorization: ComputerForegroundAuthorization | undefined,
): void {
  const blocked = authorization?.blocked;
  if (blocked) throw new CuaActionError(blocked.message, "not-dispatched", blocked.code);
}
