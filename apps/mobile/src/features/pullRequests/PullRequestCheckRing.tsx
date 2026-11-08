import { View } from "react-native";
import Svg, { Circle } from "react-native-svg";

import { useThemeColor } from "../../lib/useThemeColor";
import { checkRingSegments, describeCheckCounts } from "./pullRequestCheckRingModel";
import type { PullRequestCheckCounts } from "./pullRequestListModel";

/**
 * A pull request's checks as one ring: passed, failed and running checks as
 * arcs in that order clockwise from the top, the rest as the track. The ring
 * reads at a glance like the host's own status circle, and its label says the
 * counts for VoiceOver.
 */
export function PullRequestCheckRing(props: {
  readonly counts: PullRequestCheckCounts;
  readonly size?: number;
  readonly strokeWidth?: number;
}) {
  const size = props.size ?? 18;
  const stroke = props.strokeWidth ?? Math.max(2, size / 8);
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const track = useThemeColor("--color-border") as string;
  const success = useThemeColor("--color-success") as string;
  const danger = useThemeColor("--color-danger-foreground") as string;
  const running = useThemeColor("--color-warning") as string;
  const colors = { passed: success, failed: danger, running };
  const segments = checkRingSegments(props.counts, circumference);
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={describeCheckCounts(props.counts)}
      style={{ width: size, height: size }}
    >
      <Svg width={size} height={size} style={{ transform: [{ rotate: "-90deg" }] }}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={track}
          strokeWidth={stroke}
          fill="none"
        />
        {segments.map((segment) => (
          <Circle
            key={segment.kind}
            cx={size / 2}
            cy={size / 2}
            r={radius}
            stroke={colors[segment.kind]}
            strokeWidth={stroke}
            strokeDasharray={`${segment.length} ${circumference - segment.length}`}
            strokeDashoffset={-segment.offset}
            strokeLinecap="butt"
            fill="none"
          />
        ))}
      </Svg>
    </View>
  );
}
