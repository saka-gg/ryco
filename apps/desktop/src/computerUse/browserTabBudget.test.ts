import { describe, expect, it } from "vite-plus/test";
import {
  BROWSER_IDLE_SUSPEND_MS,
  BROWSER_LIVE_TAB_LIMIT,
  BROWSER_PRESSURED_IDLE_SUSPEND_MS,
  BROWSER_WARM_TAB_LIMIT,
  planTabBudget,
  type BudgetTab,
} from "./browserTabBudget.ts";

const NOW = 1_000_000_000;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** A live, unpinned, unheld tab hidden for `idle` ms. */
function tab(id: string, idle: number, extra: Partial<BudgetTab> = {}): BudgetTab {
  return {
    id,
    scope: "p",
    live: true,
    pinned: false,
    heldUntil: 0,
    lastActiveAt: NOW - idle,
    ...extra,
  };
}

/** Applies a plan: the suspended tabs are no longer live. */
function apply(tabs: readonly BudgetTab[], suspend: readonly string[]): BudgetTab[] {
  return tabs.map((item) => (suspend.includes(item.id) ? { ...item, live: false } : item));
}

describe("planTabBudget", () => {
  it("suspends a hidden tab at exactly 10 minutes idle", () => {
    expect(planTabBudget([tab("a", BROWSER_IDLE_SUSPEND_MS - 1)], NOW)).toEqual({
      suspend: [],
      nextCheckAt: NOW + 1,
    });
    expect(planTabBudget([tab("a", BROWSER_IDLE_SUSPEND_MS)], NOW)).toEqual({
      suspend: ["a"],
      nextCheckAt: null,
    });
  });

  it("sheds only a scope's excess over the warm limit, least recently used first", () => {
    const shown = tab("shown", 0, { pinned: true });
    const hidden = (base: number) =>
      Array.from({ length: 7 }, (_, index) => tab(`h${index}`, base + (6 - index) * SECOND));
    // 1 pinned + 7 hidden tabs idle for 61-67 s: 8 live, warm limit 6, so the 2 oldest go.
    const pressured = planTabBudget([shown, ...hidden(61 * SECOND)], NOW);
    expect(pressured.suspend).toEqual(["h0", "h1"]);
    // The remaining 6 are at the limit again, so they wait for the 10-minute idle time.
    expect(pressured.nextCheckAt).toBe(NOW - 65 * SECOND + BROWSER_IDLE_SUSPEND_MS);
    // Hidden for 53-59 s: nothing yet, and the oldest is planned at its 60 s mark.
    const early = planTabBudget([shown, ...hidden(53 * SECOND)], NOW);
    expect(early.suspend).toEqual([]);
    expect(early.nextCheckAt).toBe(NOW - 59 * SECOND + BROWSER_PRESSURED_IDLE_SUSPEND_MS);
  });

  it("applies the warm limit per scope", () => {
    const tabs = [
      ...Array.from({ length: 4 }, (_, index) =>
        tab(`a${index}`, 2 * MINUTE + index, { scope: "a" }),
      ),
      ...Array.from({ length: 4 }, (_, index) =>
        tab(`b${index}`, 2 * MINUTE + index, { scope: "b" }),
      ),
    ];
    const plan = planTabBudget(tabs, NOW);
    expect(plan.suspend).toEqual([]);
    expect(plan.nextCheckAt).toBe(NOW - (2 * MINUTE + 3) + BROWSER_IDLE_SUSPEND_MS);
  });

  it("suspends the least recently used tabs past the live limit, ties broken by id", () => {
    // 12 tabs in 4 scopes (3 each, under the warm limit), all active within the last second.
    const tabs = Array.from({ length: 12 }, (_, index) =>
      tab(`t${String(index).padStart(2, "0")}`, index < 3 ? 500 : 100, { scope: `s${index % 4}` }),
    );
    expect(planTabBudget(tabs, NOW).suspend).toEqual(["t00", "t01"]);
  });

  it("never suspends pinned or held tabs, even over the live limit", () => {
    const held = Array.from({ length: 6 }, (_, index) =>
      tab(`held${index}`, 20 * MINUTE, {
        scope: `s${index}`,
        heldUntil: NOW + (index + 1) * SECOND,
      }),
    );
    const pinned = Array.from({ length: 6 }, (_, index) =>
      tab(`pinned${index}`, 20 * MINUTE, { scope: `q${index}`, pinned: true }),
    );
    const plan = planTabBudget([...held, ...pinned], NOW);
    expect(plan.suspend).toEqual([]);
    expect(plan.nextCheckAt).toBe(NOW + SECOND);
    // A pinned tab that is also held is planned at its hold expiry (its throttling re-sync).
    expect(
      planTabBudget([tab("both", 0, { pinned: true, heldUntil: NOW + 5 * SECOND })], NOW),
    ).toEqual({ suspend: [], nextCheckAt: NOW + 5 * SECOND });
  });

  it("plans nothing when every live tab is pinned and unheld, and ignores suspended tabs", () => {
    expect(planTabBudget([tab("a", 20 * MINUTE, { pinned: true })], NOW)).toEqual({
      suspend: [],
      nextCheckAt: null,
    });
    expect(planTabBudget([], NOW)).toEqual({ suspend: [], nextCheckAt: null });
    // Suspended tabs count toward neither a scope nor the live limit, and never schedule.
    const suspended = Array.from({ length: 20 }, (_, index) =>
      tab(`z${index}`, 30 * MINUTE, { live: false }),
    );
    expect(planTabBudget(suspended, NOW)).toEqual({ suspend: [], nextCheckAt: null });
    const live = Array.from({ length: BROWSER_WARM_TAB_LIMIT }, (_, index) =>
      tab(`l${index}`, 2 * MINUTE),
    );
    expect(planTabBudget([...suspended, ...live], NOW)).toEqual({
      suspend: [],
      nextCheckAt: NOW - 2 * MINUTE + BROWSER_IDLE_SUSPEND_MS,
    });
  });

  it("keeps its invariants over mixed inputs", () => {
    // A fixed pseudo-random table (no Math.random): scopes, pins, holds and idle times.
    let seed = 7;
    const next = (limit: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % limit;
    };
    const idleTimes = [
      0,
      30 * SECOND,
      59 * SECOND,
      60 * SECOND,
      61 * SECOND,
      5 * MINUTE,
      10 * MINUTE,
      11 * MINUTE,
    ];
    for (let round = 0; round < 400; round++) {
      const tabs = Array.from({ length: 1 + next(24) }, (_, index) =>
        tab(`t${index}`, idleTimes[next(idleTimes.length)]!, {
          scope: ["", "a", "b", "c"][next(4)]!,
          live: next(6) !== 0,
          pinned: next(5) === 0,
          heldUntil:
            next(4) === 0 ? NOW + (1 + next(60)) * SECOND : next(2) === 0 ? NOW - SECOND : 0,
        }),
      );
      const plan = planTabBudget(tabs, NOW);
      if (plan.nextCheckAt !== null) expect(plan.nextCheckAt).toBeGreaterThan(NOW);
      const after = apply(tabs, plan.suspend);
      expect(planTabBudget(after, NOW).suspend).toEqual([]);
      const live = after.filter((item) => item.live);
      const eligible = live.filter((item) => !item.pinned && item.heldUntil <= NOW);
      if (eligible.length > 0) expect(live.length).toBeLessThanOrEqual(BROWSER_LIVE_TAB_LIMIT);
      for (const id of plan.suspend) {
        const planned = tabs.find((item) => item.id === id)!;
        expect(planned.live && !planned.pinned && planned.heldUntil <= NOW).toBe(true);
      }
    }
  });
});
