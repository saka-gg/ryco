import { Fragment, useId, useState } from "react";
import { View } from "react-native";
import Svg, {
  Circle,
  Defs,
  LinearGradient,
  Line,
  Path,
  Rect,
  Stop,
  Text as SvgText,
} from "react-native-svg";
import { AppText as Text } from "../../../components/AppText";
import { chartDomain, closestPoint, monotonePath } from "./chartGeometry";
import { compact, dayLabel, useStatisticsPalette } from "./StatisticsParts";

export function StatisticsChart(props: {
  points: readonly { date: string; first: number; second: number }[];
  format: (value: number) => string;
  axisFormat?: (value: number) => string;
  kind: "usage" | "changes";
}) {
  const colors = useStatisticsPalette();
  const id = `statistics-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const height = props.kind === "usage" ? 300 : 200;
  const left = 44,
    right = 10,
    top = 18,
    bottom = 30;
  const plotWidth = Math.max(1, width - left - right);
  const plotHeight = height - top - bottom;
  const domain = chartDomain(
    props.kind === "changes" ? -Math.max(0, ...props.points.map((point) => point.second)) : 0,
    Math.max(
      0,
      ...props.points.flatMap((point) =>
        props.kind === "usage" ? [point.first, point.second] : [point.first],
      ),
    ),
  );
  const positive = domain.max;
  const negative = -domain.min;
  const x = (index: number) =>
    left + (props.points.length > 1 ? index / (props.points.length - 1) : 0.5) * plotWidth;
  const y = (value: number) => top + ((positive - value) / (positive + negative)) * plotHeight;
  const first = props.points.map((point, index) => ({ x: x(index), y: y(point.first) }));
  const second = props.points.map((point, index) => ({ x: x(index), y: y(point.second) }));
  const firstColor = props.kind === "usage" ? "#d97757" : colors.success;
  const secondColor = props.kind === "usage" ? colors.foreground : colors.danger;
  const dateIndices = [
    ...new Set(
      Array.from({ length: Math.min(4, props.points.length) }, (_, index) =>
        Math.round(
          (index * (props.points.length - 1)) / Math.max(1, Math.min(4, props.points.length) - 1),
        ),
      ),
    ),
  ];
  const selectedPoint = selected === null ? null : props.points[selected];
  const area = (points: typeof first) =>
    points.length
      ? `${monotonePath(points)}L${points.at(-1)!.x},${y(0)}L${points[0]!.x},${y(0)}Z`
      : "";
  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{ height: height + 22 }}
    >
      {width > 0 ? (
        <View
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={
            selectedPoint
              ? `${dayLabel(selectedPoint.date)}, ${props.format(selectedPoint.first)}, ${props.format(selectedPoint.second)}`
              : "Daily chart. Touch or drag to inspect values."
          }
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={(event) =>
            setSelected((index) =>
              Math.min(
                props.points.length - 1,
                Math.max(0, (index ?? 0) + (event.nativeEvent.actionName === "increment" ? 1 : -1)),
              ),
            )
          }
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderGrant={(event) =>
            setSelected(
              closestPoint(event.nativeEvent.locationX, left, plotWidth, props.points.length),
            )
          }
          onResponderMove={(event) =>
            setSelected(
              closestPoint(event.nativeEvent.locationX, left, plotWidth, props.points.length),
            )
          }
          onResponderTerminate={() => setSelected(null)}
        >
          <Svg width={width} height={height}>
            <Defs>
              <LinearGradient
                id={`${id}a`}
                gradientUnits="userSpaceOnUse"
                x1={0}
                y1={Math.min(y(0) - 1, ...first.map((point) => point.y))}
                x2={0}
                y2={y(0)}
              >
                <Stop offset="5%" stopColor={firstColor} stopOpacity={0.3} />
                <Stop offset="95%" stopColor={firstColor} stopOpacity={0.02} />
              </LinearGradient>
              <LinearGradient
                id={`${id}b`}
                gradientUnits="userSpaceOnUse"
                x1={0}
                y1={Math.min(y(0) - 1, ...second.map((point) => point.y))}
                x2={0}
                y2={y(0)}
              >
                <Stop offset="5%" stopColor={secondColor} stopOpacity={0.18} />
                <Stop offset="95%" stopColor={secondColor} stopOpacity={0.01} />
              </LinearGradient>
            </Defs>
            {Array.from(
              { length: 5 },
              (_, index) => positive - (index * (positive + negative)) / 4,
            ).map((value) => (
              <ViewlessGrid
                key={value}
                y={y(value)}
                left={left}
                width={width - right}
                color={colors.border}
                labelColor={colors.muted}
                label={(props.axisFormat ?? compact)(Math.abs(value))}
                dashed={props.kind === "usage"}
              />
            ))}
            {dateIndices.map((index) => (
              <SvgText
                key={index}
                x={x(index)}
                y={height - 7}
                fill={colors.muted}
                fontSize={10}
                fontFamily="DMSans_400Regular"
                textAnchor={
                  index === 0 ? "start" : index === props.points.length - 1 ? "end" : "middle"
                }
              >
                {dayLabel(props.points[index]!.date)}
              </SvgText>
            ))}
            {props.kind === "usage" ? (
              <>
                <Path d={area(first)} fill={`url(#${id}a)`} />
                <Path d={area(second)} fill={`url(#${id}b)`} />
                <Path d={monotonePath(first)} fill="none" stroke={firstColor} strokeWidth={1.75} />
                <Path
                  d={monotonePath(second)}
                  fill="none"
                  stroke={secondColor}
                  strokeWidth={1.75}
                />
                {first.length === 1 ? (
                  <>
                    <Circle cx={first[0]!.x} cy={first[0]!.y} r={3} fill={firstColor} />
                    <Circle cx={second[0]!.x} cy={second[0]!.y} r={3} fill={secondColor} />
                  </>
                ) : null}
              </>
            ) : (
              props.points.map((point, index) => {
                const bar = Math.min(18, plotWidth / Math.max(1, props.points.length) / 2.5);
                return (
                  <Fragment key={point.date}>
                    <Rect
                      key={`${point.date}a`}
                      x={x(index) - bar}
                      y={y(point.first)}
                      width={bar}
                      height={Math.max(0, y(0) - y(point.first))}
                      rx={2}
                      fill={firstColor}
                    />
                    <Rect
                      key={`${point.date}b`}
                      x={x(index)}
                      y={y(0)}
                      width={bar}
                      height={Math.max(0, y(-point.second) - y(0))}
                      rx={2}
                      fill={secondColor}
                    />
                  </Fragment>
                );
              })
            )}
            {selectedPoint && selected !== null ? (
              <>
                <Line
                  x1={x(selected)}
                  x2={x(selected)}
                  y1={top}
                  y2={height - bottom}
                  stroke={colors.muted}
                  strokeDasharray="3 3"
                />
                <Circle
                  cx={x(selected)}
                  cy={y(selectedPoint.first)}
                  r={4}
                  fill={firstColor}
                  stroke={colors.card}
                  strokeWidth={2}
                />
                <Circle
                  cx={x(selected)}
                  cy={y(props.kind === "usage" ? selectedPoint.second : -selectedPoint.second)}
                  r={4}
                  fill={secondColor}
                  stroke={colors.card}
                  strokeWidth={2}
                />
              </>
            ) : null}
          </Svg>
          {selectedPoint ? (
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                top: 24,
                left: Math.min(Math.max(8, x(selected!) - 90), Math.max(8, width - 192)),
                width: 184,
                padding: 12,
                gap: 8,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.card,
              }}
            >
              <Text style={{ fontSize: 12 }}>{dayLabel(selectedPoint.date)}</Text>
              {[
                [props.kind === "usage" ? "Claude" : "Added", firstColor, selectedPoint.first],
                [props.kind === "usage" ? "Codex" : "Removed", secondColor, selectedPoint.second],
              ].map(([label, color, value]) => (
                <View
                  key={String(label)}
                  style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
                >
                  <View
                    style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: String(color) }}
                  />
                  <Text style={{ flex: 1, fontSize: 11, color: colors.muted }}>{label}</Text>
                  <Text style={{ fontSize: 11 }}>{props.format(Number(value))}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 16 }}>
        {[
          [props.kind === "usage" ? "Claude" : "Added", firstColor],
          [props.kind === "usage" ? "Codex" : "Removed", secondColor],
        ].map(([label, color]) => (
          <View key={label} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: color }} />
            <Text style={{ fontSize: 11, color: colors.muted }}>{label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}
function ViewlessGrid(props: {
  y: number;
  left: number;
  width: number;
  color: string;
  labelColor: string;
  label: string;
  dashed: boolean;
}) {
  return (
    <>
      <Line
        x1={props.left}
        x2={props.width}
        y1={props.y}
        y2={props.y}
        stroke={props.color}
        strokeDasharray={props.dashed ? "3 5" : undefined}
      />
      <SvgText
        x={props.left - 8}
        y={props.y + 3}
        fill={props.labelColor}
        fontSize={10}
        fontFamily="DMSans_400Regular"
        textAnchor="end"
      >
        {props.label}
      </SvgText>
    </>
  );
}
