/**
 * The app denylist as `ComputerManager` applies it: which running app owns a window or pid, and
 * the refusals for input to, and content reads of, denylisted surfaces.
 */
import type { ComputerSpaceBroker } from "./ComputerSpaceBroker.ts";
import { currentComputerTask } from "./computerTaskContext.ts";
import type { ComputerApp, ComputerWindow } from "@ryco/contracts";
import type { ComputerBackend } from "./ComputerBackend.ts";
import { ComputerDenylistError, computerDenylistMatch } from "./computerDenylist.ts";
import { agentThreadId } from "./computerLease.ts";

/**
 * How long the running-app inventory a denylist window check resolves pids
 * through may be reused. `list_windows` carries an app name and a pid but no
 * bundle id, so a name that does not itself match the denylist is resolved
 * through `list_apps` — the same read `computer_list_apps` makes. Caching it
 * keeps every click and keystroke from paying for a process enumeration;
 * thirty seconds is short enough that a freshly-installed password manager is
 * still refused on essentially the next call.
 */
const COMPUTER_DENYLIST_APP_CACHE_MS = 30_000;

export class ComputerDenylistGuard {
  private readonly backend: ComputerBackend;
  private readonly now: () => number;
  private readonly readWindows: () => Promise<readonly ComputerWindow[]>;
  private readonly spaceBroker: ComputerSpaceBroker;
  /**
   * The running-app inventory the denylist's pid resolution reuses; see
   * `COMPUTER_DENYLIST_APP_CACHE_MS` for the bound.
   */
  private deniedAppsCache:
    | { readonly at: number; readonly apps: readonly ComputerApp[] }
    | undefined;

  constructor(deps: {
    readonly backend: ComputerBackend;
    readonly now: () => number;
    readonly readWindows: () => Promise<readonly ComputerWindow[]>;
    readonly spaceBroker: ComputerSpaceBroker;
  }) {
    this.backend = deps.backend;
    this.now = deps.now;
    this.readWindows = deps.readWindows;
    this.spaceBroker = deps.spaceBroker;
  }

  /**
   * The denylist check for the admission/consent keys, which are the raw
   * strings a tool call declared — an app name, a bundle id, an executable
   * path, or the `pid <n>` fallback consent uses when a pid could not be
   * named. Synchronous by contract: both call sites are consent bookkeeping
   * that cannot await a process enumeration, so the pid fallback resolves
   * only against the last cached inventory rather than paying for a fresh
   * one inside the serialized operation queue.
   */
  assertDrivenAppAllowed(app: string): void {
    const direct = computerDenylistMatch({ name: app });
    if (direct) throw new ComputerDenylistError(direct.app, direct.matched);
    const pidMatch = /^pid ([1-9]\d*)$/.exec(app.trim().toLowerCase());
    if (pidMatch === null) return;
    const pid = Number(pidMatch[1]);
    const owner = this.deniedAppsCache?.apps.find((candidate) => candidate.pid === pid);
    if (owner === undefined) return;
    const resolved = computerDenylistMatch({
      name: owner.name,
      bundleId: owner.bundleId,
    });
    if (resolved) throw new ComputerDenylistError(resolved.app, resolved.matched);
  }

  /**
   * The running-app inventory a window's pid resolves through. A window row
   * carries a name and a pid but no bundle id, so a name that does not itself
   * match is checked against the app's bundle id — how `com.dashlane.*` is
   * caught when the reported appName is just "Dashlane". The list is cached
   * briefly rather than enumerated per input; a failed enumeration reuses the
   * stale copy rather than closing the check open.
   */
  async runningAppsForDenylist(): Promise<readonly ComputerApp[]> {
    const listApps = this.backend.listApps?.bind(this.backend);
    if (listApps === undefined) return this.deniedAppsCache?.apps ?? [];
    const now = this.now();
    const cached = this.deniedAppsCache;
    if (cached !== undefined && now - cached.at < COMPUTER_DENYLIST_APP_CACHE_MS) {
      return cached.apps;
    }
    const apps = await listApps().catch(() => undefined);
    if (apps === undefined) return cached?.apps ?? [];
    this.deniedAppsCache = { at: now, apps };
    return apps;
  }

  /** How a listed window's owning app matches the denylist, or nothing. */
  async deniedMatchForWindow(
    window: ComputerWindow,
  ): Promise<ReturnType<typeof computerDenylistMatch>> {
    const direct = computerDenylistMatch({ name: window.appName });
    if (direct) return direct;
    if (window.pid === undefined) return undefined;
    const owner = (await this.runningAppsForDenylist()).find(
      (candidate) => candidate.pid === window.pid,
    );
    if (owner === undefined) return undefined;
    return computerDenylistMatch({
      name: owner.name,
      bundleId: owner.bundleId,
    });
  }

  /** How a pid-grain target's owning app matches the denylist, or nothing. */
  async deniedMatchForPid(
    pid: number,
    name: string | undefined,
  ): Promise<ReturnType<typeof computerDenylistMatch>> {
    const direct = computerDenylistMatch({ name });
    if (direct) return direct;
    const owner = (await this.runningAppsForDenylist()).find((candidate) => candidate.pid === pid);
    if (owner === undefined) return undefined;
    return computerDenylistMatch({
      name: owner.name,
      bundleId: owner.bundleId,
    });
  }

  /**
   * Refuse an agent's input bound for a denylisted window. The human's own
   * pane input is exempt — `threadId` undefined identifies the person at the
   * keyboard, the same exemption the lease makes — while every agent-driven
   * path resolves the window's app before a raise, a focus pin, or a dispatch
   * can touch it.
   */
  async assertWindowInputAllowed(threadId: string | undefined, windowId: string): Promise<void> {
    if (agentThreadId(threadId) === undefined) return;
    const window = (await this.readWindows()).find((candidate) => candidate.id === windowId);
    if (window === undefined) return;
    await this.assertWindowInputAllowedWindow(threadId, window);
  }

  /**
   * The same input check for a window the caller already listed — the
   * window-grain mutation paths resolve their target before consent, so they
   * check the row they hold rather than paying for a second enumeration.
   */
  async assertWindowInputAllowedWindow(
    threadId: string | undefined,
    window: ComputerWindow,
  ): Promise<void> {
    if (agentThreadId(threadId) === undefined) return;
    const match = await this.deniedMatchForWindow(window);
    if (match) throw new ComputerDenylistError(match.app, match.matched);
    await this.spaceBroker.assertWindowAllowed(
      { threadId: threadId!, turnId: currentComputerTask()?.turnId ?? null },
      window,
    );
  }

  /**
   * Refuse a scoped read of a denylisted window — state, element tree, zoomed
   * capture, verify — for every caller, pane included. The accessibility tree
   * of a password manager carries field values, so scoping into the window is
   * refused outright; presence stays visible through `list_windows`.
   */
  async assertWindowContentAllowed(windowId: string): Promise<void> {
    const window = (await this.readWindows()).find((candidate) => candidate.id === windowId);
    if (window === undefined) return;
    const match = await this.deniedMatchForWindow(window);
    if (match) throw new ComputerDenylistError(match.app, match.matched);
  }

  /**
   * The visible denylisted windows, when any are on screen. Unscoped content
   * reads — a workspace screenshot, a desktop-wide tree on dialects that
   * answer one — cannot exclude a visible denied surface's pixels or
   * elements, so they refuse while one is shown.
   */
  async deniedVisibleWindows(): Promise<
    ReadonlyArray<{
      readonly window: ComputerWindow;
      readonly match: NonNullable<ReturnType<typeof computerDenylistMatch>>;
    }>
  > {
    const denied: Array<{
      readonly window: ComputerWindow;
      readonly match: NonNullable<ReturnType<typeof computerDenylistMatch>>;
    }> = [];
    for (const window of await this.readWindows()) {
      if (!window.visible || window.minimized) continue;
      const match = await this.deniedMatchForWindow(window);
      if (match) denied.push({ window, match });
    }
    return denied;
  }

  async deniedVisibleWindow(): Promise<
    | {
        readonly window: ComputerWindow;
        readonly match: NonNullable<ReturnType<typeof computerDenylistMatch>>;
      }
    | undefined
  > {
    return (await this.deniedVisibleWindows())[0];
  }

  /** Whether a window id names a denylisted surface; for best-effort observation skips. */
  async windowIsDenied(windowId: string): Promise<boolean> {
    const window = (await this.readWindows()).find((candidate) => candidate.id === windowId);
    return window !== undefined && (await this.deniedMatchForWindow(window)) !== undefined;
  }
}
