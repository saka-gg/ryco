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
 * longer than 10 s with a 503 (apps/server/src/httpStartupGate.ts). The
 * document only sends such requests once it has committed, so the hold is
 * measured from the commit (from the request while it is still pending). A
 * backend that took longer than this from that point to serving may have
 * failed the early document's first requests, so `ready` loads it again.
 */
export const EARLY_APP_LOAD_MAX_HOLD_MS = 9_000;

/**
 * How long an app navigation started at `bound` may stay uncommitted while the
 * window shows no document at all. Normally the backend serves the shell within
 * a few hundred milliseconds of binding; longer means its event loop is stalled
 * (a long migration), and the window would sit blank. It goes back to the boot
 * page instead, and `ready` loads the app.
 */
export const EARLY_APP_LOAD_COMMIT_TIMEOUT_MS = 750;

/** An app load requested from one backend child, per window. */
export interface AppLoadRequest<Backend = unknown> {
  readonly backend: Backend;
  readonly requestedAtMs: number;
  /** When the navigation was actually started (it waits for cache maintenance). */
  navigationStartedAtMs?: number | undefined;
  /** When the app document committed (`did-navigate`). */
  committedAtMs?: number | undefined;
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
  const { request } = input;
  return (
    request !== undefined &&
    !request.failed &&
    input.backend !== null &&
    request.backend === input.backend &&
    input.nowMs - (request.committedAtMs ?? request.requestedAtMs) < EARLY_APP_LOAD_MAX_HOLD_MS
  );
}

/**
 * Whether an app navigation was started and has neither committed nor failed:
 * the window still shows whatever it showed before (nothing, if that was an
 * uncommitted boot page).
 */
export function isAppLoadAwaitingCommit(request: AppLoadRequest | undefined): boolean {
  return (
    request !== undefined &&
    !request.failed &&
    request.navigationStartedAtMs !== undefined &&
    request.committedAtMs === undefined
  );
}

/**
 * Whether an early app load leaves the window blank for too long: started at
 * `bound`, uncommitted after {@link EARLY_APP_LOAD_COMMIT_TIMEOUT_MS}, over a
 * window with no committed document, and its backend not serving yet (once it
 * serves, the document arrives and nothing would load it again).
 */
export function isEarlyAppLoadStalled(input: {
  readonly request: AppLoadRequest | undefined;
  readonly currentUrl: string;
  /** The request's backend is still the current one and has not settled yet. */
  readonly backendStarting: boolean;
  readonly nowMs: number;
}): boolean {
  const startedAtMs = input.request?.navigationStartedAtMs;
  return (
    startedAtMs !== undefined &&
    isAppLoadAwaitingCommit(input.request) &&
    input.backendStarting &&
    (input.currentUrl.length === 0 || input.currentUrl === "about:blank") &&
    input.nowMs - startedAtMs >= EARLY_APP_LOAD_COMMIT_TIMEOUT_MS
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
   * The window's renderer process is gone (crashed or killed). Its document
   * cannot reconnect, whatever it reported before, so only a load revives it.
   */
  readonly rendererGone?: boolean;
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
  return input.shellUsable && input.rendererGone !== true ? "reconnect" : "load";
}
