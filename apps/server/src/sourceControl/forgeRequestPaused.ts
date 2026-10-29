/**
 * Recognises a forge call Ryco refused itself while the forge's host was
 * paused after a rate limit (`ForgeRequestPausedError`, raised by the pause in
 * `forgeRateLimit.ts`). Nothing reached the forge, so such a refusal must not
 * be kept as the forge's answer: it costs nothing to ask again, and an
 * interactive caller (which the pause never refuses) would get it from a cache
 * a background reader filled.
 *
 * The caches on the server's boot path read it, so it stays import-free; the
 * pause itself loads with the forge providers.
 */

/** The tag of `ForgeRequestPausedError`. */
export const FORGE_REQUEST_PAUSED_TAG = "ForgeRequestPausedError";

/**
 * Provider errors wrap client errors, which wrap VcsProcess's spawn error,
 * which wraps the refusal: a few levels cover every path.
 */
const MAX_CAUSE_DEPTH = 4;

/**
 * The refusal `error` is, or wraps through `cause`, when it is a forge call
 * refused locally during a rate-limit pause; null otherwise.
 */
export function findForgeRequestRefusal(error: unknown): object | null {
  let current = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return null;
    const record = current as { readonly _tag?: unknown; readonly cause?: unknown };
    if (record._tag === FORGE_REQUEST_PAUSED_TAG) return current;
    current = record.cause;
  }
  return null;
}

/**
 * True when `error`, or an error it wraps through `cause`, is a forge call
 * refused locally during a rate-limit pause.
 */
export function isForgeRequestRefusedWhilePaused(error: unknown): boolean {
  return findForgeRequestRefusal(error) !== null;
}
