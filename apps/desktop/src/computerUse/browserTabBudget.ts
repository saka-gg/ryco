// The memory budget of the Ryco browser's tabs: which hidden pages to unload, and when to look
// again. Pure: no Electron, no timers. The mechanism and numbers follow Synara's browser manager
// (apps/desktop/src/browserManager.ts), adapted to Ryco's per-tab host windows.

/** Open tabs, live or suspended (the previous hard cap, unchanged). */
export const BROWSER_TAB_LIMIT = 24;
/**
 * Live page runtimes before the least recently used eligible tab is suspended at once. Synara
 * keeps 12, but its runtimes are views inside the main window; every Ryco tab also owns a hidden
 * host BrowserWindow, so the cap is 2 lower. One constant, to be tuned once measured.
 */
export const BROWSER_LIVE_TAB_LIMIT = 10;
/**
 * Live tabs per scope (a project key, or "" for agent-opened tabs) before that scope's least
 * recently used tabs hidden for BROWSER_PRESSURED_IDLE_SUSPEND_MS are suspended, down to this
 * count. Synara: 5 warm hidden tabs per thread plus the shown one.
 */
export const BROWSER_WARM_TAB_LIMIT = 6;
/** A hidden tab nobody used for this long is suspended (Synara: 10 min). */
export const BROWSER_IDLE_SUSPEND_MS = 10 * 60_000;
/** The idle time after which a scope over its warm limit sheds its excess (Synara: 60 s). */
export const BROWSER_PRESSURED_IDLE_SUSPEND_MS = 60_000;
/** A thumbnail capture keeps its tab live and unthrottled this long (the preview polls every 2 s). */
export const BROWSER_PREVIEW_HOLD_MS = 5_000;
/** An agent command waits at most this long for a suspended tab to reload. */
export const BROWSER_REVIVE_WAIT_MS = 30_000;

export interface BudgetTab {
  readonly id: string;
  /** Tab-strip scope: the project key, or "" for agent-opened tabs (shown in every strip). */
  readonly scope: string;
  readonly live: boolean;
  /** Mounted, last shown, popped out, signing in, DevTools open, audible, or opening/running agent CDP. */
  readonly pinned: boolean;
  /**
   * Never suspended before this time: the agent claim window, the thumbnail hold (both also keep
   * the page unthrottled) or a revival's load wait.
   */
  readonly heldUntil: number;
  /** Last show/hide transition, user command, thumbnail capture or agent use. */
  readonly lastActiveAt: number;
}
export interface BudgetPlan {
  /** Tabs to suspend now, least recently used first. */
  readonly suspend: readonly string[];
  /** When to plan again (always later than `now`), or null when no remaining live tab can expire. */
  readonly nextCheckAt: number | null;
}

const byLeastRecent = (a: BudgetTab, b: BudgetTab): number =>
  a.lastActiveAt - b.lastActiveAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Plans one pass of the budget. Only live tabs that are neither pinned nor held are candidates;
 * pinned and held tabs still count toward their scope and the live cap, so the cap can be exceeded
 * only by them. When every live tab is pinned or held, nothing is suspended and the next hold
 * expiry plans again.
 */
export function planTabBudget(tabs: readonly BudgetTab[], now: number): BudgetPlan {
  const live = tabs.filter((tab) => tab.live);
  const candidates = live
    .filter((tab) => !tab.pinned && tab.heldUntil <= now)
    .toSorted(byLeastRecent);
  const suspend = new Set<string>();
  // 1. Idle: hidden for 10 minutes.
  for (const tab of candidates)
    if (now - tab.lastActiveAt >= BROWSER_IDLE_SUSPEND_MS) suspend.add(tab.id);
  // 2. Pressure: a scope over its warm limit sheds only its excess, least recently used first,
  //    and only tabs hidden for at least BROWSER_PRESSURED_IDLE_SUSPEND_MS.
  const inScope = new Map<string, number>();
  for (const tab of live)
    if (!suspend.has(tab.id)) inScope.set(tab.scope, (inScope.get(tab.scope) ?? 0) + 1);
  for (const tab of candidates) {
    const count = inScope.get(tab.scope) ?? 0;
    if (suspend.has(tab.id) || count <= BROWSER_WARM_TAB_LIMIT) continue;
    if (now - tab.lastActiveAt < BROWSER_PRESSURED_IDLE_SUSPEND_MS) continue;
    suspend.add(tab.id);
    inScope.set(tab.scope, count - 1);
  }
  // 3. Global cap: least recently used first, regardless of idle time.
  let remaining = live.length - suspend.size;
  for (const tab of candidates) {
    if (remaining <= BROWSER_LIVE_TAB_LIMIT) break;
    if (suspend.has(tab.id)) continue;
    suspend.add(tab.id);
    inScope.set(tab.scope, (inScope.get(tab.scope) ?? 0) - 1);
    remaining--;
  }
  // 4. Next check. Every time here is later than `now`: a remaining candidate is idle for less
  //    than 10 min, and one in a scope still over the warm limit was skipped in stage 2 only
  //    because it has been hidden for less than 60 s. A held tab (pinned or not) schedules its
  //    hold expiry, which also re-syncs its throttling.
  let nextCheckAt = Number.POSITIVE_INFINITY;
  for (const tab of live) {
    if (suspend.has(tab.id)) continue;
    if (tab.heldUntil > now) nextCheckAt = Math.min(nextCheckAt, tab.heldUntil);
    else if (!tab.pinned) {
      const pressured = (inScope.get(tab.scope) ?? 0) > BROWSER_WARM_TAB_LIMIT;
      const delay = pressured ? BROWSER_PRESSURED_IDLE_SUSPEND_MS : BROWSER_IDLE_SUSPEND_MS;
      nextCheckAt = Math.min(nextCheckAt, tab.lastActiveAt + delay);
    }
  }
  return {
    suspend: candidates.filter((tab) => suspend.has(tab.id)).map((tab) => tab.id),
    nextCheckAt: Number.isFinite(nextCheckAt) ? nextCheckAt : null,
  };
}
