import { View } from "react-native";
import {
  USAGE_COST_TYPE_COLORS,
  USAGE_COST_TYPE_LABELS,
  formatUsageCostShare,
  listUsageCostTypeShares,
  type UsageCostBreakdownTotals,
} from "@ryco/client-runtime/usage";
import { AppText as Text } from "../../../components/AppText";
import { Note, money, useStatisticsPalette } from "./StatisticsParts";

/**
 * Estimated cost by token type in the usage cost card: one stacked share bar, a legend, the
 * Fast-mode premium and what could not be split. Renders nothing when nothing is split.
 */
export function UsageCostByType({ totals }: { totals: UsageCostBreakdownTotals }) {
  const colors = useStatisticsPalette();
  const shares = listUsageCostTypeShares(totals);
  if (!shares.length) return null;
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 16, gap: 12 }}>
      <Text className="font-ryco-medium" style={{ fontSize: 12 }}>
        Cost by type
      </Text>
      <View
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        style={{
          flexDirection: "row",
          height: 8,
          gap: 1,
          borderRadius: 4,
          overflow: "hidden",
          backgroundColor: colors.accent,
        }}
      >
        {shares.map((entry) => (
          <View
            key={entry.type}
            style={{
              flexGrow: entry.share,
              flexBasis: 0,
              backgroundColor: USAGE_COST_TYPE_COLORS[entry.type],
            }}
          />
        ))}
      </View>
      <View style={{ gap: 8 }}>
        {shares.map((entry) => (
          <View
            key={entry.type}
            accessible
            style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
          >
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                backgroundColor: USAGE_COST_TYPE_COLORS[entry.type],
              }}
            />
            <Text style={{ flex: 1, fontSize: 12, color: colors.muted }}>
              {USAGE_COST_TYPE_LABELS[entry.type]}
            </Text>
            <Text className="font-ryco-medium" style={{ fontSize: 12 }}>
              {money(entry.usd)}
            </Text>
            <Text style={{ minWidth: 36, fontSize: 12, color: colors.muted, textAlign: "right" }}>
              {formatUsageCostShare(entry.share)}
            </Text>
          </View>
        ))}
      </View>
      {totals.speedPremiumUsd > 0 ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
          <Text style={{ flex: 1, fontSize: 12, color: colors.muted }}>
            Fast-mode premium (included)
          </Text>
          <Text className="font-ryco-medium" style={{ fontSize: 12 }}>
            {money(totals.speedPremiumUsd)}
          </Text>
        </View>
      ) : null}
      {totals.otherUsd > 0 && totals.unsplitBucketCount > 0 ? (
        <Note>
          Some cost could not be split: provider-reported costs without published rates, or nodes
          that need an update.
        </Note>
      ) : null}
    </View>
  );
}
