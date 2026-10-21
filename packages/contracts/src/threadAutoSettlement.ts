import * as Schema from "effect/Schema";

/**
 * The automatic settlement rule: a thread with no activity for this many days
 * moves to Settled. Null turns it off. A leaf module, so the settings and the
 * orchestration shell can both carry the rule without importing each other.
 */
export const SIDEBAR_AUTO_SETTLE_DAY_OPTIONS = [1, 3, 7, 14, 30, 90] as const;
export const SidebarAutoSettleAfterDays = Schema.NullOr(
  Schema.Literals(SIDEBAR_AUTO_SETTLE_DAY_OPTIONS),
);
export type SidebarAutoSettleAfterDays = typeof SidebarAutoSettleAfterDays.Type;
export const DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS: SidebarAutoSettleAfterDays = 7;
