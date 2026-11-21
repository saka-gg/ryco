/**
 * What a surface (the browser, the terminal) does when one of its user action requests ends,
 * however it ended: the user's answer, the surface's own condition, the expiry or the agent's
 * withdrawal. The browser gives the tab back to the agent here, after keeping what the user typed
 * private.
 *
 * Tiny and on the boot path on purpose: a surface registers its hook when it is built, so a
 * request answered before any agent of this process opened one still reaches it. The request
 * module itself loads lazily (`userActionRequests.ts`).
 *
 * @module userActionRequests/surfaceHooks
 */
import type { ThreadId, UserActionOutcome, UserActionSurface } from "@ryco/contracts";
import type { Effect } from "effect";

export interface UserActionSurfaceEnded {
  readonly threadId: ThreadId;
  readonly requestId: string;
  readonly target: string | null;
  readonly outcome: UserActionOutcome;
}

export type UserActionSurfaceHook = (ended: UserActionSurfaceEnded) => Effect.Effect<void>;

const hooks = new Map<UserActionSurface, UserActionSurfaceHook>();

/** Sets the surface's hook (one per surface; a later one replaces it). Returns its removal. */
export function registerUserActionSurfaceHook(
  surface: UserActionSurface,
  hook: UserActionSurfaceHook,
): () => void {
  hooks.set(surface, hook);
  return () => {
    if (hooks.get(surface) === hook) hooks.delete(surface);
  };
}

export function userActionSurfaceHook(
  surface: UserActionSurface,
): UserActionSurfaceHook | undefined {
  return hooks.get(surface);
}
