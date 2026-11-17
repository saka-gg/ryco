import type { InboxSidebarEnvironmentSources } from "./inboxSidebarModel";

/** How long after its live connection drops a saved machine may read as reconnecting. */
export const SAVED_ENVIRONMENT_RECONNECT_GRACE_MS = 30_000;

/**
 * Remembers when each saved machine's live connection dropped (the runtime keeps
 * when a connection opened, not when it was last live) and answers, for each
 * machine still in its grace, when that grace ends. A retry that fails after
 * the drop ends it early, unless the failure is known not to be "unreachable":
 * a machine that is off then reads offline at once instead of flickering
 * between offline and connecting. A failure of unknown kind counts as
 * unreachable: this client does not sort failures (`lastErrorKind`), and the
 * socket failures it records are ones `classifySavedEnvironmentFailure` calls
 * unreachable. Calling it again with the same states is a no-op, so a memo may
 * call it on every rebuild. Presentation only: it decides no connection.
 */
export function createSavedEnvironmentReconnectGrace() {
  // true: connected; a number: when it dropped; false: no grace.
  let graceById = new Map<string, boolean | number>();
  return (
    runtimeById: InboxSidebarEnvironmentSources["savedEnvironmentRuntimeById"],
    nowMs = Date.now(),
  ): ReadonlyMap<string, number> => {
    const next = new Map<string, boolean | number>();
    const untilById = new Map<string, number>();
    for (const [environmentId, runtime] of Object.entries(runtimeById)) {
      let grace = graceById.get(environmentId) ?? false;
      if (runtime?.connectionState === "connected") grace = true;
      else if (grace === true) grace = nowMs;
      if (
        typeof grace === "number" &&
        Date.parse(runtime?.lastErrorAt ?? "") > grace &&
        (runtime?.lastErrorKind ?? "unreachable") === "unreachable"
      ) {
        grace = false;
      }
      next.set(environmentId, grace);
      if (typeof grace === "number" && nowMs < grace + SAVED_ENVIRONMENT_RECONNECT_GRACE_MS) {
        untilById.set(environmentId, grace + SAVED_ENVIRONMENT_RECONNECT_GRACE_MS);
      }
    }
    graceById = next;
    return untilById;
  };
}
