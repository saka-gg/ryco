import type { UsageProviderKind } from "@ryco/contracts";
import { USAGE_PROVIDERS } from "@ryco/client-runtime/usage";
export type StatisticsView = "usage" | "activity";
export type StatisticsRange = "7d" | "30d" | "90d" | "all";
export type UsageMetric = "cost" | "tokens";
export type UsageBreakdown = "model" | "day";
export type ActivityMetric = "turns" | "activeMs" | "files";

export interface StatisticsSearch {
  readonly view: StatisticsView;
  readonly range: StatisticsRange;
  readonly environmentIds?: readonly string[] | undefined;
  readonly providers?: readonly UsageProviderKind[] | undefined;
  readonly projectId?: string | undefined;
  readonly model?: string | undefined;
  readonly modelProvider?: string | undefined;
  readonly usageMetric: UsageMetric;
  readonly usageBreakdown: UsageBreakdown;
  readonly activityMetric: ActivityMetric;
}

function oneOf<T extends string>(value: unknown, allowed: ReadonlySet<string>, fallback: T): T {
  return typeof value === "string" && allowed.has(value) ? (value as T) : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  const values = (Array.isArray(value) ? value : typeof value === "string" ? [value] : [])
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .filter((item, index, all) => all.indexOf(item) === index)
    .toSorted();
  return values.length > 0 ? values : undefined;
}

export function parseStatisticsSearch(raw: Record<string, unknown>): StatisticsSearch {
  const environmentIds = stringArray(raw["environmentIds"]);
  const providers = stringArray(raw["providers"])?.filter(
    (provider): provider is UsageProviderKind =>
      (USAGE_PROVIDERS as readonly string[]).includes(provider),
  );
  const projectId = optionalString(raw["projectId"]);
  const model = optionalString(raw["model"]);
  const modelProvider = optionalString(raw["modelProvider"]);
  return {
    view: oneOf(raw["view"], new Set(["usage", "activity"]), "usage"),
    range: oneOf(raw["range"], new Set(["7d", "30d", "90d", "all"]), "30d"),
    ...(environmentIds === undefined ? {} : { environmentIds }),
    ...(providers === undefined || providers.length === 0 ? {} : { providers }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(model === undefined ? {} : { model }),
    ...(modelProvider === undefined ? {} : { modelProvider }),
    usageMetric: oneOf(raw["usageMetric"], new Set(["cost", "tokens"]), "cost"),
    usageBreakdown: oneOf(raw["usageBreakdown"], new Set(["model", "day"]), "model"),
    activityMetric: oneOf(raw["activityMetric"], new Set(["turns", "activeMs", "files"]), "turns"),
  };
}
