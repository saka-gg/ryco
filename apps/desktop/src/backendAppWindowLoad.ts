/**
 * What a packaged window does when a backend becomes reachable.
 *
 * - `load`: the window shows the boot page or nothing yet, so it loads the app.
 * - `reconnect`: it already shows a booted app on this backend's origin. The
 *   backend restarted after a crash (same origin, same bundled binary), so the
 *   renderer reconnects and resyncs in place instead of reloading, which would
 *   lose its route and redo the whole boot.
 * - `load` also covers a document on the backend's origin that never reported a
 *   usable shell (an error page from a load that hit the dying backend, or a
 *   half-booted app): only a fresh load recovers those.
 * - `ignore`: anything else (an external page the window was navigated to), or
 *   a window whose app load was already requested from this same backend.
 *
 * Two moments ask: `bound` (the backend's port is bound; it serves the static
 * app shell and holds API and WebSocket requests until its router attaches) and
 * `ready` (the backend serves). Only a window still on the boot page loads at
 * `bound`; reconnecting or replacing a backend-origin document waits for
 * `ready`.
 */
export type BackendAppWindowAction = "load" | "reconnect" | "ignore";

/**
 * How long an app load requested at `bound` stays valid. The backend holds the
 * renderer's API and WebSocket requests until it serves, but answers those held
 * longer than 10 s with a 503 (apps/server/src/httpStartupGate.ts). A backend
 * that took longer than this from bind to serving may have failed the early
 * document's first requests, so `ready` loads it again.
 */
export const EARLY_APP_LOAD_MAX_HOLD_MS = 9_000;

/** An app load requested from one backend child, per window. */
export interface AppLoadRequest<Backend = unknown> {
  readonly backend: Backend;
  readonly requestedAtMs: number;
  /**
   * The navigation failed (`did-fail-load`). The record stays so a backend
   * that dies before serving still finds the windows it left on an error
   * page, but it no longer counts as a load in progress.
   */
  failed: boolean;
}

/** Whether an earlier app load request still stands for the current backend. */
export function isAppLoadRequestCurrent(input: {
  readonly request: AppLoadRequest | undefined;
  readonly backend: unknown;
  readonly nowMs: number;
}): boolean {
  return (
    input.request !== undefined &&
    !input.request.failed &&
    input.backend !== null &&
    input.request.backend === input.backend &&
    input.nowMs - input.request.requestedAtMs < EARLY_APP_LOAD_MAX_HOLD_MS
  );
}

export type BackendAppWindowMoment = "bound" | "ready";

export function resolveBackendAppWindowAction(input: {
  readonly currentUrl: string;
  readonly backendHttpUrl: string;
  readonly isBootUrl: (url: string) => boolean;
  /** Whether the current document reported a usable app shell. */
  readonly shellUsable: boolean;
  /**
   * Whether this window's app load was already requested from the current
   * backend (and has not failed): at `bound`, so `ready` must not repeat it.
   */
  readonly loadRequestedFromThisBackend?: boolean;
  readonly moment?: BackendAppWindowMoment;
}): BackendAppWindowAction {
  if (input.loadRequestedFromThisBackend === true) return "ignore";
  const { currentUrl } = input;
  if (currentUrl.length === 0 || currentUrl === "about:blank" || input.isBootUrl(currentUrl)) {
    return "load";
  }
  if ((input.moment ?? "ready") === "bound") return "ignore";
  if (!currentUrl.startsWith(input.backendHttpUrl)) return "ignore";
  return input.shellUsable ? "reconnect" : "load";
}
