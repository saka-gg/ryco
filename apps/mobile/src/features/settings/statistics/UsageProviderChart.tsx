import { useState } from "react";
import { View } from "react-native";
import Svg, { Circle, Line, Path, Text as SvgText } from "react-native-svg";
import {
  USAGE_PROVIDERS,
  USAGE_PROVIDER_COLORS,
  USAGE_PROVIDER_LABELS,
  type UsageDayPoint,
} from "@ryco/client-runtime/usage";
import { AppText as Text } from "../../../components/AppText";
import { chartDomain, closestPoint, monotonePath } from "./chartGeometry";
import { compact, dayLabel, integer, money, useStatisticsPalette } from "./StatisticsParts";

/** Native presentation of the shared nullable usage series. Gaps stay unavailable. */
export function UsageProviderChart({
  points,
  metric,
}: {
  readonly points: readonly UsageDayPoint[];
  readonly metric: string;
}) {
  const colors = useStatisticsPalette();
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const suffix = metric === "cost" ? "Cost" : "Tokens";
  const format =
    metric === "cost"
      ? money
      : (value: number | null) => (value === null ? "Unavailable" : integer(value));
  const left = 44,
    right = 10,
    top = 18,
    bottom = 30,
    height = 300;
  const plotWidth = Math.max(1, width - left - right);
  const maximum = chartDomain(
    0,
    points.reduce(
      (maximum, day) =>
        USAGE_PROVIDERS.reduce(
          (value, provider) => Math.max(value, day[`${provider}${suffix}`] ?? 0),
          maximum,
        ),
      0,
    ),
  ).max;
  const x = (index: number) =>
    left + (points.length > 1 ? index / (points.length - 1) : 0.5) * plotWidth;
  const y = (value: number) => top + (1 - value / maximum) * (height - top - bottom);
  const day = selected === null ? undefined : points[selected];
  const active = USAGE_PROVIDERS.filter((provider) =>
    points.some((day) => day[`${provider}${suffix}`] !== null),
  );
  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ gap: 12 }}>
      {width > 0 ? (
        <View
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={
            day
              ? `${dayLabel(day.date)}, ${active.map((provider) => `${USAGE_PROVIDER_LABELS[provider]} ${format(day[`${provider}${suffix}`])}`).join(", ")}`
              : "Daily usage chart. Touch to inspect values."
          }
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={(event) =>
            setSelected((index) =>
              Math.max(
                0,
                Math.min(
                  points.length - 1,
                  (index ?? 0) + (event.nativeEvent.actionName === "increment" ? 1 : -1),
                ),
              ),
            )
          }
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderGrant={(event) =>
            setSelected(closestPoint(event.nativeEvent.locationX, left, plotWidth, points.length))
          }
          onResponderMove={(event) =>
            setSelected(closestPoint(event.nativeEvent.locationX, left, plotWidth, points.length))
          }
        >
          <Svg width={width} height={height}>
            {Array.from({ length: 5 }, (_, index) => (maximum * index) / 4).map((value) => (
              <Line
                key={value}
                x1={left}
                x2={width - right}
                y1={y(value)}
                y2={y(value)}
                stroke={colors.border}
                strokeDasharray="3 5"
              />
            ))}
            {Array.from({ length: 5 }, (_, index) => (maximum * index) / 4).map((value) => (
              <SvgText
                key={value}
                x={left - 8}
                y={y(value) + 3}
                fill={colors.muted}
                textAnchor="end"
                fontSize={10}
              >
                {metric === "cost" ? `$${value.toFixed(1)}` : compact(value)}
              </SvgText>
            ))}
            {[...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])]
              .filter((index) => index >= 0)
              .map((index) => (
                <SvgText
                  key={index}
                  x={x(index)}
                  y={height - 7}
                  fill={colors.muted}
                  textAnchor={
                    index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"
                  }
                  fontSize={10}
                >
                  {dayLabel(points[index]!.date)}
                </SvgText>
              ))}
            {active.flatMap((provider) => {
              const segments: { x: number; y: number }[][] = [[]];
              points.forEach((point, index) => {
                const value = point[`${provider}${suffix}`];
                if (value === null) {
                  if (segments.at(-1)!.length) segments.push([]);
                } else segments.at(-1)!.push({ x: x(index), y: y(value) });
              });
              return segments
                .filter((segment) => segment.length)
                .map((segment) =>
                  segment.length === 1 ? (
                    <Circle
                      key={`${provider}:${segment[0]!.x}`}
                      cx={segment[0]!.x}
                      cy={segment[0]!.y}
                      r={3}
                      fill={USAGE_PROVIDER_COLORS[provider]}
                    />
                  ) : (
                    <Path
                      key={`${provider}:${segment[0]!.x}`}
                      d={monotonePath(segment)}
                      fill="none"
                      stroke={USAGE_PROVIDER_COLORS[provider]}
                      strokeWidth={1.75}
                    />
                  ),
                );
            })}
            {selected !== null && day ? (
              <Line
                x1={x(selected)}
                x2={x(selected)}
                y1={top}
                y2={height - bottom}
                stroke={colors.muted}
                strokeDasharray="3 3"
              />
            ) : null}
          </Svg>
        </View>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        {active.map((provider) => (
          <View key={provider} style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                backgroundColor: USAGE_PROVIDER_COLORS[provider],
              }}
            />
            <Text style={{ fontSize: 11, color: colors.muted }}>
              {USAGE_PROVIDER_LABELS[provider]}
              {day ? ` ${format(day[`${provider}${suffix}`])}` : ""}
            </Text>
          </View>
        ))}
      </View>
      {day ? <Text style={{ fontSize: 11, color: colors.muted }}>{dayLabel(day.date)}</Text> : null}
    </View>
  );
}
