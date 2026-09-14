import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { AppText as Text } from "../../../components/AppText";
import { Note, useStatisticsPalette } from "./StatisticsParts";

export function ActivityHeatmap({
  points,
  format,
}: {
  points: readonly { date: string; first: number }[];
  format: (value: number) => string;
}) {
  const colors = useStatisticsPalette();
  const [selection, setSelection] = useState<string | null>(null);
  const leading = points[0] ? new Date(`${points[0].date}T00:00:00Z`).getUTCDay() : 0;
  const cells = [...Array<null>(leading).fill(null), ...points];
  const weeks = Array.from({ length: Math.ceil(cells.length / 7) }, (_, index) =>
    cells.slice(index * 7, index * 7 + 7),
  );
  const max = Math.max(1, ...points.map((point) => point.first));
  const selected = points.find((point) => point.date === selection);
  return (
    <View className="gap-2">
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ flexDirection: "row", gap: 3 }}>
          {weeks.map((week) => (
            <View key={week.find((cell) => cell !== null)?.date} style={{ gap: 3 }}>
              {week.map((cell, day) =>
                cell ? (
                  <Pressable
                    key={cell.date}
                    onPress={() => setSelection(cell.date)}
                    accessibilityLabel={`${cell.date}: ${format(cell.first)}`}
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 3,
                      backgroundColor: cell.first > 0 ? colors.primary : colors.accent,
                      opacity:
                        cell.first > 0
                          ? [0, 0.28, 0.5, 0.74, 1][Math.min(4, Math.ceil((cell.first / max) * 4))]
                          : 1,
                    }}
                  />
                ) : (
                  <View
                    key={`padding-${["sun", "mon", "tue", "wed", "thu", "fri", "sat"][day]}`}
                    style={{ width: 10, height: 10 }}
                  />
                ),
              )}
            </View>
          ))}
        </View>
      </ScrollView>
      <View
        style={{ flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 6 }}
      >
        <Text style={{ fontSize: 11, color: colors.muted }}>Less</Text>
        {[0, 0.28, 0.5, 0.74, 1].map((opacity) => (
          <View
            key={opacity}
            style={{
              width: 10,
              height: 10,
              borderRadius: 3,
              backgroundColor: opacity === 0 ? colors.accent : colors.primary,
              opacity: opacity || 1,
            }}
          />
        ))}
        <Text style={{ fontSize: 11, color: colors.muted }}>More</Text>
      </View>
      <Note>
        {selected
          ? `${selected.date} · ${format(selected.first)}`
          : "Tap a day to inspect activity · UTC"}
      </Note>
    </View>
  );
}
