import { MVP_ROOT_ROUTES, MVP_SETTINGS_SHEET_ROUTES } from "../../../navigation/mvpRouteConfig";

export type StatisticsTab = "usage" | "activity" | "limits";

const STATISTICS_TABS: ReadonlySet<string> = new Set<StatisticsTab>([
  "usage",
  "activity",
  "limits",
]);

/** The tab a Statistics link names (`settings/statistics?tab=limits`), or null for none known. */
export function statisticsTabParam(
  value: string | readonly string[] | undefined,
): StatisticsTab | null {
  const tab = typeof value === "string" ? value : value?.[0];
  return tab !== undefined && STATISTICS_TABS.has(tab) ? (tab as StatisticsTab) : null;
}

/** The link path that opens Statistics on one tab, such as a Limits widget's tap. */
export function statisticsLinkPath(tab: StatisticsTab): string {
  const settings = MVP_ROOT_ROUTES.SettingsSheet.linking;
  const statistics = MVP_SETTINGS_SHEET_ROUTES.SettingsStatistics.linking;
  return `${settings}/${statistics}?tab=${tab}`;
}
