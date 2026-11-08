import { MenuView } from "@react-native-menu/menu";
import { useIsFocused, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId } from "@ryco/contracts";
import type { StatRange } from "@ryco/client-runtime/usage";
import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, View } from "react-native";
import Animated, {
  FadeIn,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { MotionReveal } from "../../components/MotionReveal";
import { useThemeColor } from "../../lib/useThemeColor";
import { MAIN_TABS } from "../../navigation/tabs/mainTabsModel";
import {
  TabLargeTitle,
  useLargeTitleCollapse,
  useTabStackHeader,
} from "../../navigation/tabs/TabScreenChrome";
import { useHomeEnvironments } from "../home/useHomeEnvironments";
import { canChangeNodeSettings } from "../settings/nodeSettingsTargets";
import { ActivityStatistics } from "../settings/statistics/ActivityStatistics";
import { ProviderLimits } from "../settings/statistics/ProviderLimits";
import { providerLimitsNodes } from "../settings/statistics/providerLimitsModel";
import { Tabs } from "../settings/statistics/StatisticsParts";
import { statisticsTabParam } from "../settings/statistics/statisticsRoute";
import { UsageStatistics } from "../settings/statistics/UsageStatistics";
import { useStatisticsData } from "../settings/statistics/useStatisticsData";
import { useLimitsFocusRefresh } from "./useLimitsFocusRefresh";
import {
  ALL_DEVICES,
  DEFAULT_USAGE_RANGE,
  DEFAULT_USAGE_VIEW,
  USAGE_RANGE_OPTIONS,
  USAGE_VIEW_OPTIONS,
  scopeUsageEnvironments,
  usageContentState,
  usageDeviceMenu,
  usageViewHasRange,
  type UsageDeviceMenu,
  type UsageDeviceNotice,
  type UsageView,
} from "./usageTabModel";

const TITLE = MAIN_TABS.Usage.title;
// A quick refresh never flashes the content: dimming waits this long.
const UPDATING_DELAY_MS = 150;
const UPDATING_FADE = { duration: 150, reduceMotion: ReduceMotion.System } as const;

/**
 * The Usage tab: subscription limits, provider-recorded usage and work
 * activity of the connected devices. A view switch picks one; Usage and
 * Activity also pick a date window. Limits ask the providers again when the
 * tab comes back into view after a while, and every view refreshes on pull.
 */
export function UsageTabScreen(
  props: StaticScreenProps<
    | {
        /** The view to open, as a link names it (`usage?tab=limits`). */
        readonly tab?: string | string[];
      }
    | undefined
  >,
) {
  const environments = useHomeEnvironments();
  const linkedView = statisticsTabParam(props.route.params?.tab);
  const [view, setView] = useState<UsageView>(linkedView ?? DEFAULT_USAGE_VIEW);
  // A link that names a view opens it, also while Usage is already open.
  const [followedView, setFollowedView] = useState(linkedView);
  if (linkedView !== followedView) {
    setFollowedView(linkedView);
    if (linkedView !== null) setView(linkedView);
  }
  const [range, setRange] = useState<StatRange>(DEFAULT_USAGE_RANGE);
  const [device, setDevice] = useState(ALL_DEVICES);
  const scope = scopeUsageEnvironments(environments, device, view);
  const menu = usageDeviceMenu(environments, scope, view);
  const data = useStatisticsData(scope.scoped, view, range);
  const limitNodes = providerLimitsNodes(data.nodes);

  const focused = useIsFocused();
  const limitsRefresh = useLimitsFocusRefresh(focused && view === "limits", data.reload);
  // The pull's spinner stays until every device answered the refresh it started.
  const [pulled, setPulled] = useState(false);
  if (pulled && !data.loading) setPulled(false);
  const refresh = () => {
    if (view === "limits") limitsRefresh.asked();
    setPulled(true);
    data.refresh();
  };

  const { collapsed, onScroll } = useLargeTitleCollapse();
  const showDeviceFilter = environments.length > 1;
  useTabStackHeader(
    showDeviceFilter
      ? {
          title: collapsed ? TITLE : "",
          headerRight: () => <DeviceFilterButton menu={menu} onChange={setDevice} />,
        }
      : { title: collapsed ? TITLE : "" },
  );

  // Reset credits are spent only through a connected, mutation-ready owner session.
  const canRedeem = (environmentId: EnvironmentId) =>
    environments.some(
      (environment) =>
        environment.environmentId === environmentId && canChangeNodeSettings(environment),
    );
  const hasContent =
    view === "limits"
      ? limitNodes.length > 0
      : view === "usage"
        ? data.usage !== null
        : data.nodes.some((node) => node.activity !== undefined);
  const state = usageContentState({
    view,
    environmentCount: environments.length,
    scopedCount: scope.scoped.length,
    loading: data.loading,
    hasContent,
    nodes: data.nodes.map((node) => ({
      environmentId: node.environment.environmentId,
      label: node.environment.label,
      error: node.error,
    })),
  });
  // The pull has its own spinner; the line under the title covers the app's own refreshes.
  const updating = data.refreshing && !pulled;

  return (
    <ScrollView
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingTop: 4, paddingBottom: 40 }}
      onScroll={onScroll}
      scrollEventThrottle={16}
      refreshControl={<RefreshControl refreshing={pulled} onRefresh={refresh} />}
    >
      <TabLargeTitle title={TITLE}>
        <View className="h-5 flex-row items-center gap-3 px-4">
          <Text className="flex-1 text-sm text-foreground-muted" numberOfLines={1}>
            {menu.label}
          </Text>
          {updating ? <UpdatingLabel /> : null}
        </View>
      </TabLargeTitle>
      <View className="gap-5 px-4">
        <Tabs label="View" value={view} onChange={setView} options={USAGE_VIEW_OPTIONS} />
        <MotionReveal key={view}>
          <View className="gap-5">
            {usageViewHasRange(view) ? (
              <Tabs
                compact
                label="Date range"
                value={range}
                onChange={setRange}
                options={USAGE_RANGE_OPTIONS}
              />
            ) : null}
            {state.kind === "no-devices" || state.kind === "empty" ? (
              <EmptyState variant="plain" title={state.title} detail={state.detail} />
            ) : null}
            {state.kind === "loading" ? <LoadingState label={state.label} /> : null}
            {state.kind === "failed" ? (
              <EmptyState
                variant="plain"
                title={view === "limits" ? "Limits unavailable" : "Usage unavailable"}
                detail={failedDetail(state.notices)}
                actionLabel="Try again"
                onAction={refresh}
              />
            ) : null}
            {state.kind === "ready" ? (
              <Updating dimmed={data.refreshing}>
                <DeviceNotices notices={state.notices} />
                {view === "limits" ? (
                  <ProviderLimits
                    nodes={limitNodes}
                    canRedeem={canRedeem}
                    onRefresh={data.refresh}
                  />
                ) : null}
                {view === "usage" && data.usage !== null ? (
                  <UsageStatistics summary={data.usage} />
                ) : null}
                {view === "activity"
                  ? data.nodes.map((node) =>
                      node.activity ? (
                        <ActivityStatistics
                          key={node.environment.environmentId}
                          snapshot={node.activity}
                          range={range}
                        />
                      ) : null,
                    )
                  : null}
              </Updating>
            ) : null}
          </View>
        </MotionReveal>
      </View>
    </ScrollView>
  );
}

function failedDetail(notices: readonly UsageDeviceNotice[]): string {
  const [only] = notices;
  if (notices.length === 1 && only !== undefined) return only.message;
  return notices.map((notice) => `${notice.label}: ${notice.message}`).join("\n");
}

/** The header's device filter; its icon fills while one device is picked. */
function DeviceFilterButton(props: {
  readonly menu: UsageDeviceMenu;
  readonly onChange: (device: string) => void;
}) {
  const iconColor = useThemeColor("--color-icon");
  return (
    <MenuView
      title={props.menu.title}
      actions={props.menu.options.map((option) => ({
        id: option.value,
        title: option.label,
        state: option.value === props.menu.value ? "on" : "off",
      }))}
      onPressAction={({ nativeEvent }) => props.onChange(nativeEvent.event)}
    >
      <View
        accessibilityRole="button"
        accessibilityLabel={`Devices: ${props.menu.label}`}
        className="h-11 w-11 items-center justify-center rounded-full"
      >
        <SymbolView
          name={
            props.menu.filtered
              ? "line.3.horizontal.decrease.circle.fill"
              : "line.3.horizontal.decrease.circle"
          }
          size={20}
          tintColor={iconColor as string}
          type="monochrome"
        />
      </View>
    </MenuView>
  );
}

function LoadingState(props: { readonly label: string }) {
  return (
    <View className="items-center gap-3 py-16" accessibilityLiveRegion="polite">
      <ActivityIndicator />
      <Text className="text-center text-base text-foreground-muted">{props.label}</Text>
    </View>
  );
}

/** A device that could not answer, beside what the others did. */
function DeviceNotices(props: { readonly notices: readonly UsageDeviceNotice[] }) {
  const iconColor = useThemeColor("--color-icon-muted");
  if (props.notices.length === 0) return null;
  return (
    <View className="gap-2">
      {props.notices.map((notice) => (
        <View
          key={notice.key}
          className="flex-row items-start gap-3 rounded-2xl border border-border bg-card px-4 py-3"
        >
          <View className="pt-0.5">
            <SymbolView
              name="exclamationmark.triangle"
              size={15}
              tintColor={iconColor as string}
              type="monochrome"
            />
          </View>
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="font-ryco-medium text-sm text-foreground" numberOfLines={1}>
              {notice.label}
            </Text>
            <Text className="text-xs leading-[18px] text-foreground-muted">{notice.message}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

/** While devices answer a refresh, the last numbers stay, dimmed. */
function Updating(props: { readonly dimmed: boolean; readonly children: ReactNode }) {
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.set(
      props.dimmed
        ? withDelay(UPDATING_DELAY_MS, withTiming(0.5, UPDATING_FADE), ReduceMotion.System)
        : withTiming(1, UPDATING_FADE),
    );
  }, [opacity, props.dimmed]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return (
    <Animated.View style={style} className="gap-5" accessibilityState={{ busy: props.dimmed }}>
      {props.children}
    </Animated.View>
  );
}

function UpdatingLabel() {
  return (
    <Animated.View
      entering={FadeIn.delay(UPDATING_DELAY_MS).duration(150).reduceMotion(ReduceMotion.System)}
      accessibilityLiveRegion="polite"
      className="flex-row items-center gap-1.5"
    >
      <ActivityIndicator size="small" />
      <Text className="text-xs text-foreground-muted">Updating…</Text>
    </Animated.View>
  );
}
