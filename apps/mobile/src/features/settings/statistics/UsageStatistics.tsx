import { useState } from "react";
import { Pressable, View } from "react-native";
import {
  IconCoin,
  IconStack2,
  IconBrain,
  IconDatabase,
  IconSparkles,
  IconAlertCircle,
} from "@tabler/icons-react-native";
import {
  buildUsageBreakdown,
  buildUsageDaySeries,
  filterUsageBuckets,
  sumUsageTotals,
  type MergedUsageSummary,
} from "@ryco/client-runtime/usage";
import { AppText as Text } from "../../../components/AppText";
import {
  MiniMetric,
  Note,
  Panel,
  Toggle,
  compact,
  integer,
  money,
  dayLabel,
  useStatisticsPalette,
} from "./StatisticsParts";
import { StatisticsChart } from "./StatisticsCharts";

export function UsageStatistics({ summary }: { summary: MergedUsageSummary }) {
  const colors = useStatisticsPalette();
  const [providers, setProviders] = useState(["claude", "codex"]);
  const [metric, setMetric] = useState("cost");
  const [breakdown, setBreakdown] = useState("model");
  const buckets = filterUsageBuckets(summary, providers);
  const totals = sumUsageTotals(summary, buckets);
  const series = buildUsageDaySeries(summary, buckets);
  const rows = buildUsageBreakdown(buckets, breakdown === "day" ? "day" : "model");
  const pricedCoverage =
    totals.pricedTokenCount + totals.unpricedTokenCount
      ? Math.round(
          (totals.pricedTokenCount / (totals.pricedTokenCount + totals.unpricedTokenCount)) * 100,
        )
      : 0;
  const cacheInput =
    totals.cachedInputTokens + totals.uncachedInputTokens + totals.cacheCreationInputTokens;
  const included = summary.sources.filter((source) => source.included);
  const issues = included.filter((source) => source.status !== "complete");
  const pricingStates = summary.environments.flatMap((environment) =>
    environment.summary ? [environment.summary.pricing.state] : [],
  );
  const pricing = !pricingStates.length
    ? "Unavailable"
    : pricingStates.every((state) => state === "live")
      ? "Live"
      : pricingStates.every((state) => state === "cached")
        ? "Cached"
        : pricingStates.every((state) => state === "unavailable")
          ? "Unavailable"
          : "Mixed";
  const latestScan = included
    .map((source) => source.scanFinishedAt)
    .toSorted()
    .at(-1);
  const pricingFetch = summary.environments
    .flatMap((environment) =>
      environment.summary?.pricing.fetchedAt ? [environment.summary.pricing.fetchedAt] : [],
    )
    .toSorted()
    .at(-1);
  return (
    <View style={{ gap: 32 }}>
      <View style={{ gap: 16 }}>
        <View
          style={{
            alignSelf: "flex-start",
            flexDirection: "row",
            padding: 2,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: 8,
            backgroundColor: colors.card,
          }}
        >
          {["claude", "codex"].map((provider) => (
            <Pressable
              key={provider}
              accessibilityRole="button"
              accessibilityState={{ selected: providers.includes(provider) }}
              onPress={() =>
                setProviders((current) =>
                  current.includes(provider)
                    ? current.length > 1
                      ? current.filter((item) => item !== provider)
                      : current
                    : [...current, provider],
                )
              }
              style={{
                flexDirection: "row",
                gap: 6,
                alignItems: "center",
                paddingHorizontal: 10,
                height: 30,
                borderRadius: 6,
                backgroundColor: providers.includes(provider) ? colors.accent : "transparent",
              }}
            >
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: provider === "claude" ? "#d97757" : colors.foreground,
                }}
              />
              <Text
                style={{
                  fontSize: 12,
                  color: providers.includes(provider) ? colors.foreground : colors.muted,
                }}
              >
                {provider === "claude" ? "Claude" : "Codex"}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text style={{ fontSize: 14, lineHeight: 22.75, color: colors.muted }}>
          Provider-recorded usage from Claude Code and Codex transcripts on the selected machines.
          This includes sessions run outside Ryco and is intentionally not attributed to projects.
        </Text>
      </View>
      {!buckets.length ? (
        <Panel title="No usage in this range">
          <Note>
            The transcript sources were found, but no provider-recorded usage matched these filters.
          </Note>
        </Panel>
      ) : (
        <>
          <View
            style={{
              borderRadius: 16,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.card,
              overflow: "hidden",
            }}
          >
            <View
              style={{
                padding: 24,
                gap: 24,
                borderBottomWidth: 1,
                borderBottomColor: colors.border,
              }}
            >
              <View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <IconCoin size={14} color={colors.muted} />
                  <Text
                    className="font-ryco-bold"
                    style={{ fontSize: 11, letterSpacing: 1.32, color: colors.muted }}
                  >
                    RAW API-EQUIVALENT COST
                  </Text>
                </View>
                <Text
                  className="font-ryco-bold"
                  selectable
                  style={{
                    fontSize: 40,
                    letterSpacing: -1.8,
                    marginTop: 20,
                    color: colors.foreground,
                  }}
                >
                  {totals.estimatedCostUsd === null
                    ? "Unavailable"
                    : money(totals.estimatedCostUsd)}
                </Text>
                <View style={{ marginTop: 12 }}>
                  <Note>
                    Estimate based on base API rates. Subscription, credits, batch, negotiated, and
                    provider billing may differ.
                  </Note>
                </View>
              </View>
              <View
                style={{
                  borderTopWidth: 1,
                  borderTopColor: colors.border,
                  paddingTop: 20,
                  gap: 16,
                }}
              >
                {[
                  ["Priced coverage", `${pricedCoverage}% of tokens`],
                  ["Estimated cache savings", money(totals.estimatedCacheSavingsUsd)],
                  ["Provider-recorded tokens", integer(totals.totalTokens)],
                ].map(([label, value]) => (
                  <View
                    key={label}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 16,
                      justifyContent: "space-between",
                    }}
                  >
                    <Text style={{ color: colors.muted, fontSize: 12, flexShrink: 1 }}>
                      {label}
                    </Text>
                    <Text className="font-ryco-medium" style={{ fontSize: 12 }}>
                      {value}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
            <View style={{ padding: 16 }}>
              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 8,
                }}
              >
                <View style={{ flexShrink: 1 }}>
                  <Text className="font-ryco-bold" style={{ fontSize: 14 }}>
                    Usage over time
                  </Text>
                  <Text style={{ fontSize: 11, color: colors.muted, marginTop: 3 }}>
                    Daily values in {summary.timeZone}
                  </Text>
                </View>
                <Toggle
                  label="Usage metric"
                  value={metric}
                  onChange={setMetric}
                  options={[
                    { value: "cost", label: "Cost" },
                    { value: "tokens", label: "Tokens" },
                  ]}
                />
              </View>
              <StatisticsChart
                kind="usage"
                points={series.map((day) => ({
                  date: day.date,
                  first: metric === "cost" ? day.claudeCost : day.claudeTokens,
                  second: metric === "cost" ? day.codexCost : day.codexTokens,
                }))}
                format={metric === "cost" ? money : integer}
                axisFormat={
                  metric === "cost" ? (value) => `$${value.toFixed(value < 10 ? 1 : 0)}` : compact
                }
              />
            </View>
          </View>
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              borderTopWidth: 1,
              borderBottomWidth: 1,
              borderColor: colors.border,
            }}
          >
            {[
              ["Total tokens", compact(totals.totalTokens)],
              ["Sessions", integer(totals.distinctSessionCount)],
              ["Responses", integer(totals.responseCount)],
              [
                "Cache read",
                `${cacheInput ? Math.round((totals.cachedInputTokens / cacheInput) * 100) : 0}%`,
              ],
              ["Reasoning", compact(totals.reasoningTokens), "included in output"],
            ].map(([label, value, detail]) => (
              <View
                key={label}
                style={{
                  width: "50%",
                  paddingHorizontal: 16,
                  paddingVertical: 20,
                  borderRightWidth: 1,
                  borderColor: colors.border,
                }}
              >
                <MiniMetric label={label!} value={value!} detail={detail} />
              </View>
            ))}
          </View>
          <Panel
            title="Breakdown"
            icon={<IconStack2 size={14} color={colors.muted} />}
            flush
            action={
              <Toggle
                label="Breakdown"
                value={breakdown}
                onChange={setBreakdown}
                options={[
                  { value: "model", label: "Model" },
                  { value: "day", label: "Day" },
                ]}
              />
            }
          >
            {rows.slice(0, 20).map((row) => (
              <View
                key={row.key}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                  paddingHorizontal: 16,
                  paddingVertical: 14,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.border,
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} className="font-ryco-medium" style={{ fontSize: 14 }}>
                    {breakdown === "day" ? dayLabel(row.label) : prettyModel(row.label)}
                  </Text>
                  <Text style={{ fontSize: 11, marginTop: 2, color: colors.muted }}>
                    {row.provider
                      ? row.provider === "claude"
                        ? "Claude"
                        : "Codex"
                      : `${row.responses} responses`}
                  </Text>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text className="font-ryco-medium" style={{ fontSize: 14 }}>
                    {compact(row.tokens)}
                  </Text>
                  <Text style={{ fontSize: 11, color: colors.muted }}>tokens</Text>
                </View>
                <View style={{ alignItems: "flex-end", minWidth: 76 }}>
                  <Text className="font-ryco-medium" style={{ fontSize: 14 }}>
                    {money(row.costUsd)}
                  </Text>
                  <Text style={{ fontSize: 11, color: colors.muted }}>
                    {row.unpricedTokens ? `${compact(row.unpricedTokens)} unpriced` : "estimated"}
                  </Text>
                </View>
              </View>
            ))}
          </Panel>
          <Panel title="Coverage & estimates" icon={<IconBrain size={14} color={colors.muted} />}>
            {[
              {
                icon: IconDatabase,
                label: "Transcript sources",
                value: `${included.length} included`,
                detail: summary.duplicateSourceCount
                  ? `${summary.duplicateSourceCount} duplicate source excluded`
                  : "No physical duplicates detected",
              },
              {
                icon: IconSparkles,
                label: "Last scan",
                value: latestScan
                  ? new Date(latestScan).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })
                  : "Not scanned",
                detail: `${included.reduce((sum, source) => sum + source.reusedCacheFileCount, 0)} cached files reused`,
              },
              {
                icon: IconCoin,
                label: "Pricing",
                value: pricing,
                detail: pricingFetch
                  ? `Rates fetched ${new Date(pricingFetch).toLocaleString()}`
                  : "Token totals remain available without rates",
              },
              {
                icon: IconAlertCircle,
                label: "Coverage state",
                value: issues.length ? `${issues.length} source notices` : "Complete",
                detail: summary.environmentOnlyDeduplicationWarning
                  ? "Some sources could only be scoped per environment"
                  : `${included.reduce((sum, source) => sum + source.malformedLineCount, 0)} malformed lines skipped`,
              },
            ].map((item) => (
              <View key={item.label} style={{ flexDirection: "row", gap: 12 }}>
                <View
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: colors.accent,
                  }}
                >
                  <item.icon size={16} color={colors.muted} />
                </View>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text style={{ fontSize: 12, color: colors.muted }}>{item.label}</Text>
                  <Text className="font-ryco-medium" style={{ fontSize: 14 }}>
                    {item.value}
                  </Text>
                  <Text style={{ fontSize: 11, lineHeight: 18, color: colors.muted }}>
                    {item.detail}
                  </Text>
                </View>
              </View>
            ))}
          </Panel>
        </>
      )}
    </View>
  );
}
function prettyModel(model: string) {
  return (model.split("/").at(-1) ?? model)
    .replace(/(\d)-(\d)/g, "$1.$2")
    .split("-")
    .map((segment) =>
      segment.toLowerCase() === "gpt" ? "GPT" : segment.charAt(0).toUpperCase() + segment.slice(1),
    )
    .join(" ");
}
