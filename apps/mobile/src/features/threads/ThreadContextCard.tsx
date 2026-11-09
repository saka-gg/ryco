import type { EnvironmentId } from "@ryco/contracts";
import { BlurView } from "expo-blur";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, useColorScheme, View } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { DeviceIcon } from "../../components/DeviceIcon";
import {
  IconGitMerge,
  IconGitPullRequest,
  IconCircleDot,
  IconTicket,
} from "../../components/icons";
import { ProjectBadge } from "../../components/ProjectBadge";
import { ProviderIcon } from "../../components/ProviderIcon";
import { appBlurTargetRef } from "../../lib/appBlurTarget";
import type { ChangeRequestBadge } from "../../lib/changeRequestBadge";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  contextRingPercent,
  threadContextCardQuickButtons,
  type MachineStatusTone,
  type ThreadContextCardQuickId,
  type ThreadContextCardRow,
  type ThreadContextCardRowTarget,
} from "./threadContextCardModel";
import type { ThreadProjectBadgeView } from "./threadContextSheetModel";
import type { ThreadHeaderModel } from "./threadHeaderModel";

// The prototype's drop: 260 ms on a curve that overshoots a little, scaled from the pill.
const DROP_IN = {
  duration: 260,
  easing: Easing.bezier(0.2, 0.9, 0.25, 1.12),
  reduceMotion: ReduceMotion.System,
} as const;
const DROP_OUT = {
  duration: 140,
  easing: Easing.bezier(0.4, 0, 1, 1),
  reduceMotion: ReduceMotion.System,
} as const;
const CARD_INSET = 14;
const RING_SIZE = 16;
const RING_RADIUS = 6.75;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

const DOT_CLASS: Readonly<Record<MachineStatusTone, string>> = {
  online: "bg-success",
  connecting: "bg-warning",
  offline: "bg-foreground-tertiary",
};

const CHIP_CLASS: Readonly<Record<ChangeRequestBadge["tone"], string>> = {
  open: "bg-success-bg",
  draft: "bg-subtle-strong",
  merged: "bg-violet-500/15",
  closed: "bg-danger-foreground/15",
  neutral: "bg-subtle-strong",
};

export interface ThreadContextCardActions {
  readonly openProject: (() => void) | undefined;
  readonly openMachines: () => void;
  readonly openSourceControl: (() => void) | undefined;
  readonly openFiles: (() => void) | undefined;
  readonly openReview: (() => void) | undefined;
  readonly openPullRequest: (() => void) | undefined;
  readonly openParent: (() => void) | undefined;
  readonly openAgents: () => void;
  readonly openCacheInfo: (() => void) | undefined;
  /** The full context sheet, with everything the card leaves out. */
  readonly openDetails: () => void;
}

function PullRequestChip(props: {
  readonly badge: ChangeRequestBadge;
  readonly onPress?: (() => void) | undefined;
}) {
  const success = useThemeColor("--color-success");
  const danger = useThemeColor("--color-danger-foreground");
  const neutral = useThemeColor("--color-foreground-tertiary");
  const { badge } = props;
  const color =
    badge.tone === "merged"
      ? "#8e51ff"
      : badge.tone === "open"
        ? success
        : badge.tone === "closed"
          ? danger
          : neutral;
  const Icon =
    badge.kind === "pull-request"
      ? badge.tone === "merged"
        ? IconGitMerge
        : IconGitPullRequest
      : badge.kind === "issue"
        ? IconCircleDot
        : IconTicket;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={badge.accessibilityLabel}
      disabled={!props.onPress}
      onPress={props.onPress}
      hitSlop={6}
      className={cn(
        "h-[26px] shrink-0 flex-row items-center gap-[5px] rounded-full px-[9px] active:opacity-70",
        CHIP_CLASS[badge.tone],
      )}
    >
      <Icon size={12} strokeWidth={2} color={color as string} />
      <Text style={{ fontSize: 12, color: color as string }} numberOfLines={1}>
        {badge.label}
      </Text>
    </Pressable>
  );
}

function ContextRing(props: { readonly percent: number }) {
  const track = useThemeColor("--color-subtle-strong");
  const accent = useThemeColor("--color-accent-strong");
  const filled = (RING_LENGTH * props.percent) / 100;
  const center = RING_SIZE / 2;
  return (
    <Svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}>
      <Circle
        cx={center}
        cy={center}
        r={RING_RADIUS}
        fill="none"
        stroke={track as string}
        strokeWidth={2}
      />
      <Circle
        cx={center}
        cy={center}
        r={RING_RADIUS}
        fill="none"
        stroke={accent as string}
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={`${filled} ${RING_LENGTH}`}
        transform={`rotate(-90 ${center} ${center})`}
      />
    </Svg>
  );
}

function QuickButton(props: {
  readonly id: ThreadContextCardQuickId;
  readonly label: string;
  readonly icon: Parameters<typeof SymbolView>[0]["name"];
  readonly onPress: (() => void) | undefined;
}) {
  const iconColor = useThemeColor("--color-icon-muted");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={!props.onPress}
      onPress={props.onPress}
      className="h-8 flex-1 flex-row items-center justify-center gap-[5px] rounded-full bg-subtle-strong active:opacity-70 disabled:opacity-40"
    >
      <SymbolView name={props.icon} size={13} tintColor={iconColor} type="monochrome" />
      <Text className="text-foreground-secondary" style={{ fontSize: 12 }}>
        {props.label}
      </Text>
    </Pressable>
  );
}

function ExtraRow(props: {
  readonly row: ThreadContextCardRow;
  readonly onPress: (() => void) | undefined;
}) {
  const iconColor = useThemeColor("--color-icon-subtle");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[props.row.label, props.row.detail].filter(Boolean).join(", ")}
      disabled={!props.onPress}
      onPress={props.onPress}
      className="min-h-9 flex-row items-center gap-[9px] rounded-xl px-0.5 active:opacity-60"
    >
      <SymbolView name={props.row.icon} size={14} tintColor={iconColor} type="monochrome" />
      <Text className="min-w-0 flex-1 text-foreground" style={{ fontSize: 13.5 }} numberOfLines={1}>
        {props.row.label}
      </Text>
      {props.row.detail ? (
        <Text
          className="max-w-[45%] text-foreground-muted"
          style={{ fontSize: 12 }}
          numberOfLines={1}
        >
          {props.row.detail}
        </Text>
      ) : null}
      <SymbolView name="chevron.right" size={10} tintColor={iconColor} type="monochrome" />
    </Pressable>
  );
}

/**
 * The chat's context as a small card dropped from the title pill (no field labels): project and
 * machine with its status dot, the pull request as a chip, the branch and the model with how
 * full its context is, quick ways into Files, Changes and the PR, then compact rows for the
 * chat's extras and the full context sheet. A tap outside closes it.
 */
export function ThreadContextCard(props: {
  readonly visible: boolean;
  readonly onClose: () => void;
  /** Window y of the card's top edge: just under the header. */
  readonly top: number;
  readonly environmentId: EnvironmentId;
  readonly badge: ThreadProjectBadgeView;
  readonly model: ThreadHeaderModel;
  readonly machineStatus: MachineStatusTone;
  readonly modelRow: { readonly providerDriver: string | null; readonly label: string } | null;
  readonly contextFraction: number | null;
  readonly rows: ReadonlyArray<ThreadContextCardRow>;
  readonly actions: ThreadContextCardActions;
}) {
  const { visible, onClose } = props;
  const [mounted, setMounted] = useState(visible);
  const progress = useSharedValue(0);
  const dark = useColorScheme() === "dark";
  const popoverColor = useThemeColor("--color-popover") as string;
  const iconColor = useThemeColor("--color-icon-muted");
  const subtleIcon = useThemeColor("--color-icon-subtle");
  const separator = useThemeColor("--color-border");

  if (visible && !mounted) setMounted(true);
  useEffect(() => {
    if (!mounted) return;
    progress.set(
      visible
        ? withTiming(1, DROP_IN)
        : withTiming(0, DROP_OUT, (finished) => {
            if (finished) runOnJS(setMounted)(false);
          }),
    );
  }, [mounted, progress, visible]);

  const cardStyle = useAnimatedStyle(() => {
    const value = progress.get();
    return {
      opacity: Math.min(1, Math.max(0, value)),
      transform: [{ translateY: -10 * (1 - value) }, { scale: 0.9 + 0.1 * value }],
    };
  });

  if (!mounted) return null;

  // A row leaves the card first, then goes where it leads.
  const go = (action: (() => void) | undefined) =>
    action
      ? () => {
          onClose();
          action();
        }
      : undefined;
  const { model, actions } = props;
  const percent = contextRingPercent(props.contextFraction);
  const quick = threadContextCardQuickButtons(model);
  const quickAction: Readonly<Record<ThreadContextCardQuickId, (() => void) | undefined>> = {
    files: actions.openFiles,
    changes: actions.openReview ?? actions.openSourceControl,
    pr: actions.openPullRequest,
  };
  const rowAction: Readonly<Record<ThreadContextCardRowTarget, (() => void) | undefined>> = {
    details: actions.openDetails,
    parent: actions.openParent,
    agents: actions.openAgents,
    cache: actions.openCacheInfo,
  };

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close chat details"
        onPress={onClose}
        style={StyleSheet.absoluteFill}
      />
      <Animated.View
        accessibilityViewIsModal
        accessibilityLabel="Chat details"
        style={[
          {
            position: "absolute",
            top: props.top,
            left: CARD_INSET,
            right: CARD_INSET,
            borderRadius: 20,
            transformOrigin: "top center",
            shadowColor: "#000",
            shadowOpacity: dark ? 0.6 : 0.18,
            shadowRadius: 25,
            shadowOffset: { width: 0, height: 20 },
          },
          cardStyle,
        ]}
      >
        <View style={{ borderRadius: 20, overflow: "hidden", padding: 14, paddingBottom: 12 }}>
          <BlurView
            blurMethod="dimezisBlurView"
            blurTarget={appBlurTargetRef}
            intensity={60}
            tint={dark ? "systemMaterialDark" : "systemMaterialLight"}
            style={StyleSheet.absoluteFill}
          />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: popoverColor }]} />

          <View className="flex-row items-center" style={{ gap: 10 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Project ${model.projectLabel}. Open it.`}
              disabled={!actions.openProject}
              onPress={go(actions.openProject)}
              className="active:opacity-70"
            >
              <ProjectBadge
                environmentId={props.badge.environmentId}
                projectId={props.badge.projectId}
                customAvatarContentHash={props.badge.customAvatarContentHash}
                name={props.badge.name}
                size={34}
              />
            </Pressable>
            <View className="min-w-0 flex-1">
              <Pressable
                accessibilityRole="button"
                disabled={!actions.openProject}
                onPress={go(actions.openProject)}
                className="active:opacity-70"
              >
                <Text
                  className="font-ryco-bold text-foreground"
                  style={{ fontSize: 15 }}
                  numberOfLines={1}
                >
                  {model.projectLabel}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Machine ${model.nodeLabel}, ${props.machineStatus}. Open machines.`}
                onPress={go(actions.openMachines)}
                hitSlop={{ top: 4, bottom: 6 }}
                className="mt-0.5 flex-row items-center self-start active:opacity-70"
                style={{ gap: 5 }}
              >
                <DeviceIcon environmentId={props.environmentId} label={model.nodeLabel} size={13} />
                <Text
                  className="shrink text-foreground-muted"
                  style={{ fontSize: 12 }}
                  numberOfLines={1}
                >
                  {model.nodeLabel}
                </Text>
                <View className={cn("h-1.5 w-1.5 rounded-full", DOT_CLASS[props.machineStatus])} />
              </Pressable>
            </View>
            {model.changeRequest ? (
              <PullRequestChip badge={model.changeRequest} onPress={go(actions.openPullRequest)} />
            ) : null}
          </View>

          <View
            style={{
              height: StyleSheet.hairlineWidth,
              backgroundColor: separator,
              marginVertical: 12,
            }}
          />

          <View style={{ gap: 10 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${model.branchLabel ? "Branch" : "Folder"} ${
                model.branchLabel ?? model.worktreeLabel
              }${model.inWorktree ? ", in a worktree" : ""}. Open source control.`}
              disabled={!actions.openSourceControl}
              onPress={go(actions.openSourceControl)}
              className="flex-row items-center active:opacity-70"
              style={{ gap: 9 }}
            >
              <SymbolView
                name={model.branchLabel ? "arrow.triangle.branch" : "folder"}
                size={15}
                tintColor={iconColor}
                type="monochrome"
              />
              <Text
                className="min-w-0 flex-1 text-foreground"
                style={{ fontSize: 13.5 }}
                numberOfLines={1}
              >
                {model.branchLabel ?? model.worktreeLabel}
              </Text>
              {model.inWorktree ? (
                <Text className="text-foreground-muted" style={{ fontSize: 11 }}>
                  worktree
                </Text>
              ) : null}
            </Pressable>
            {props.modelRow ? (
              <View
                accessible
                accessibilityLabel={`Model ${props.modelRow.label}${
                  percent === null ? "" : `, context ${percent}% used`
                }`}
                className="flex-row items-center"
                style={{ gap: 9 }}
              >
                <ProviderIcon provider={props.modelRow.providerDriver} size={15} />
                <Text
                  className="min-w-0 flex-1 text-foreground"
                  style={{ fontSize: 13.5 }}
                  numberOfLines={1}
                >
                  {props.modelRow.label}
                </Text>
                {percent !== null ? (
                  <View className="flex-row items-center" style={{ gap: 6 }}>
                    <ContextRing percent={percent} />
                    <Text
                      className="text-foreground-muted"
                      style={{ fontSize: 12, fontVariant: ["tabular-nums"] }}
                    >
                      {percent}%
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>

          {quick.length > 0 ? (
            <View className="flex-row" style={{ gap: 6, marginTop: 12 }}>
              {quick.map((button) => (
                <QuickButton key={button.id} {...button} onPress={go(quickAction[button.id])} />
              ))}
            </View>
          ) : null}

          <View
            style={{
              height: StyleSheet.hairlineWidth,
              backgroundColor: separator,
              marginTop: 12,
              marginBottom: 4,
            }}
          />
          {props.rows.map((row) => (
            <ExtraRow key={row.id} row={row} onPress={go(rowAction[row.target])} />
          ))}
          <Pressable
            accessibilityRole="button"
            onPress={go(actions.openDetails)}
            className="min-h-9 flex-row items-center gap-[9px] px-0.5 active:opacity-60"
          >
            <SymbolView name="ellipsis.circle" size={14} tintColor={subtleIcon} type="monochrome" />
            <Text className="flex-1 text-foreground-muted" style={{ fontSize: 13.5 }}>
              More details
            </Text>
            <SymbolView name="chevron.right" size={10} tintColor={subtleIcon} type="monochrome" />
          </Pressable>
        </View>
      </Animated.View>
    </View>
  );
}
