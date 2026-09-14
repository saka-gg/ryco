import {
  IconGitMerge,
  IconGitPullRequest,
  IconCircleDot,
  IconTicket,
} from "@tabler/icons-react-native";
import { useThemeColor } from "../lib/useThemeColor";
import { View } from "react-native";

import { cn } from "../lib/cn";
import type { ChangeRequestBadge as ChangeRequestBadgeModel } from "../lib/changeRequestBadge";
import { AppText as Text } from "./AppText";

// Outlined, not filled. This is last-known metadata, not live status — nothing
// refreshes `prState` in the background (see lib/changeRequestBadge.ts). A solid
// status chip would read as "this is true right now", which it is not.
const TONE_CLASS: Readonly<Record<ChangeRequestBadgeModel["tone"], string>> = {
  open: "border-success/40 text-success",
  draft: "border-foreground-tertiary/40 text-foreground-tertiary",
  merged: "border-violet-500/30 bg-violet-500/10 text-violet-500",
  closed: "border-danger-foreground/40 text-danger-foreground",
  neutral: "border-border text-foreground-tertiary",
};

export function ChangeRequestBadge(props: {
  readonly badge: ChangeRequestBadgeModel;
  readonly className?: string;
}) {
  const neutral = useThemeColor("--color-foreground-tertiary");
  const success = useThemeColor("--color-success");
  const danger = useThemeColor("--color-danger-foreground");
  const color =
    props.badge.tone === "merged"
      ? "#8e51ff"
      : props.badge.tone === "open"
        ? success
        : props.badge.tone === "closed"
          ? danger
          : neutral;
  const Icon =
    props.badge.kind === "pull-request"
      ? props.badge.tone === "merged"
        ? IconGitMerge
        : IconGitPullRequest
      : props.badge.kind === "issue"
        ? IconCircleDot
        : IconTicket;
  return (
    <View
      accessible
      accessibilityLabel={props.badge.accessibilityLabel}
      className={cn(
        "shrink-0 flex-row items-center gap-1 rounded-full border px-2 py-0.5",
        TONE_CLASS[props.badge.tone],
        props.className,
      )}
    >
      <Icon size={11} strokeWidth={1.75} color={color as string} />
      <Text className={cn("font-mono text-2xs", TONE_CLASS[props.badge.tone])} numberOfLines={1}>
        {props.badge.label}
      </Text>
    </View>
  );
}
