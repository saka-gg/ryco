import { MAIN_TABS } from "../../../navigation/tabs/mainTabsModel";

export type StatisticsTab = "usage" | "activity" | "limits";

const STATISTICS_TABS: ReadonlySet<string> = new Set<StatisticsTab>([
  "usage",
  "activity",
  "limits",
]);

/** The view a Usage link names (`usage?tab=limits`), or null for none known. */
export function statisticsTabParam(
  value: string | readonly string[] | undefined,
): StatisticsTab | null {
  const tab = typeof value === "string" ? value : value?.[0];
  return tab !== undefined && STATISTICS_TABS.has(tab) ? (tab as StatisticsTab) : null;
}

/** The link path that opens the Usage tab on one view, such as a Limits widget's tap. */
export function statisticsLinkPath(tab: StatisticsTab): string {
  return `${MAIN_TABS.Usage.linking}?tab=${tab}`;
}
