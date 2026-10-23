import { CodexResetCredits } from "./CodexResetCredits";
import type { EnvironmentId, ServerProvider, ServerProviderRateLimitWindow } from "@ryco/contracts";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AppState, View } from "react-native";
import {
  availablePercent,
  describeRateLimitPace,
  groupSubscriptionLimits,
  listDirectProviderAccounts,
  nextLimitResetAtMs,
  rateLimitPace,
  type DirectAccountLocation,
} from "@ryco/client-runtime/usage";
import { AppText as Text } from "../../../components/AppText";
import { ProviderIcon } from "../../../components/ProviderIcon";
import { Note, Panel, Row } from "./StatisticsParts";

/** One device's providers, as the Limits tab read them. */
export interface ProviderLimitsNode {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  readonly providers: readonly ServerProvider[];
}

function LimitWindow({
  label,
  window,
  checkedAt,
  available,
  now,
}: {
  label: string;
  window: ServerProviderRateLimitWindow;
  checkedAt: string;
  available: boolean;
  now: number;
}) {
  const remaining = availablePercent(window.usedPercent);
  const pace = describeRateLimitPace(rateLimitPace(window, checkedAt, now, available));
  const reset = window.resetsAt ? new Date(window.resetsAt * 1000) : null;
  return (
    <View className="gap-2">
      <Row
        label={label}
        value={remaining !== null ? `${Math.round(remaining)}% left` : "Unavailable"}
      />
      {remaining !== null ? (
        <View className="h-1.5 overflow-hidden rounded-full bg-card-alt">
          <View
            style={{
              width: `${remaining}%`,
              height: 6,
              borderRadius: 3,
              backgroundColor:
                remaining <= 10 ? "#ef4444" : remaining <= 25 ? "#f59e0b" : "#22c55e",
            }}
          />
        </View>
      ) : null}
      {pace ? <Note>{pace}</Note> : null}
      {reset && Number.isFinite(reset.getTime()) ? (
        <Note>Resets {reset.toLocaleString()}</Note>
      ) : null}
    </View>
  );
}

/** One account or instance: icon, plan or status, devices, last check, then its limits. */
function LimitsPanel({
  title,
  snapshot,
  detail,
  resets,
  children,
}: {
  title: string;
  snapshot: ServerProvider;
  detail: string;
  resets: ReactNode;
  children: ReactNode;
}) {
  const limits = snapshot.rateLimits;
  return (
    <Panel title={title}>
      <View className="flex-row items-center gap-3">
        <ProviderIcon provider={snapshot.driver} size={22} />
        <View className="flex-1">
          <Text className="text-sm text-foreground-secondary">{detail}</Text>
          <Note>Checked {new Date(snapshot.checkedAt).toLocaleString()}</Note>
        </View>
      </View>
      {resets}
      {children}
      {limits?.credits ? (
        <Row
          label="Credits"
          value={
            limits.credits.unlimited
              ? "Unlimited"
              : (limits.credits.balance ?? (limits.credits.hasCredits ? "Available" : "None"))
          }
        />
      ) : null}
      {limits?.rateLimitReachedType ? (
        <Note>Limit reached · {limits.rateLimitReachedType}</Note>
      ) : null}
    </Panel>
  );
}

/**
 * Native provider limits across devices, through the same shared selector as the web Limits
 * page: each account once, grouped by provider. Mobile reads no hubs, so nothing is routed.
 */
export function ProviderLimits({
  nodes,
  canRedeem,
  onRefresh,
}: {
  nodes: readonly ProviderLimitsNode[];
  canRedeem: (environmentId: EnvironmentId) => boolean;
  onRefresh?: () => void;
}) {
  const view = useMemo(() => {
    const { accounts, withoutLimits } = listDirectProviderAccounts(
      nodes.map((node) => ({ ...node, hubs: [] })),
    );
    // A Codex instance keeps its banked resets, and any pending reset attempt, without windows.
    const resettable = withoutLimits.filter((instance) => instance.driver === "codex");
    return {
      groups: groupSubscriptionLimits({
        hubs: [],
        direct: accounts,
        routed: [],
        withoutLimits: resettable,
      }),
      windows: accounts.flatMap((account) => account.windows),
      // Every other instance without limits is named on one line.
      limitless: [
        ...new Set(
          withoutLimits
            .filter((instance) => instance.driver !== "codex")
            .map((instance) =>
              nodes.length > 1
                ? `${instance.displayName} on ${instance.environmentLabel}`
                : instance.displayName,
            ),
        ),
      ],
      empty: accounts.length === 0 && withoutLimits.length === 0,
      environmentIds: new Map<string, EnvironmentId>(
        nodes.map((node) => [node.environmentId, node.environmentId]),
      ),
    };
  }, [nodes]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (view.windows.length === 0) return;
    const timer = setTimeout(() => setNow(Date.now()), 0);
    return () => clearTimeout(timer);
  }, [view]);
  // One wakeup at the next reset, plus foreground recovery. No provider polling.
  useEffect(() => {
    const update = () => setNow(Date.now());
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") update();
    });
    const next = nextLimitResetAtMs(view.windows, Math.max(now, Date.now()));
    const timer =
      next === null
        ? undefined
        : setTimeout(update, Math.min(Math.max(0, next - Date.now()), 2_147_483_647));
    return () => {
      subscription.remove();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [view, now]);

  // With several devices in view, every account names the devices it was seen on.
  const where = (locations: readonly DirectAccountLocation[]) =>
    nodes.length > 1
      ? `on ${[...new Set(locations.map((location) => location.environmentLabel))].join(" · ")}`
      : undefined;
  const title = (locations: readonly DirectAccountLocation[]) =>
    [...new Set(locations.map((location) => location.displayName))].join(", ");
  const resetCredits = (locations: readonly DirectAccountLocation[]) =>
    locations.map((location) => {
      const environmentId = view.environmentIds.get(location.environmentId);
      if (location.driver !== "codex" || environmentId === undefined) return null;
      return (
        <View key={`${location.environmentId}\n${location.instanceId}`} className="gap-2">
          {locations.length > 1 ? (
            <Note>{`${location.displayName} on ${location.environmentLabel}`}</Note>
          ) : null}
          <CodexResetCredits
            environmentId={environmentId}
            instanceId={location.instanceId}
            onRefresh={onRefresh}
            allowed={canRedeem(environmentId) && location.authenticated}
          />
        </View>
      );
    });

  return (
    <View className="gap-4">
      <Note>
        Account limits reported by each provider. These allowances may be shared with other apps and
        devices.
      </Note>
      {view.empty ? (
        <Note>No enabled providers on {nodes.length === 1 ? "this device" : "these devices"}.</Note>
      ) : null}
      {view.groups.map((group) => (
        <View key={group.provider} className="gap-3">
          <Text className="text-lg font-ryco-bold text-foreground">{group.label}</Text>
          {group.directAccounts.map((account) => (
            <LimitsPanel
              key={account.key}
              title={title(account.locations)}
              snapshot={account.snapshot}
              detail={[account.plan ?? account.snapshot.status, where(account.locations)]
                .filter(Boolean)
                .join(" · ")}
              resets={resetCredits(account.locations)}
            >
              {account.windows.map(({ label, window }) => (
                <LimitWindow
                  key={label}
                  label={label}
                  window={window}
                  checkedAt={account.snapshot.checkedAt}
                  available={account.available}
                  now={now}
                />
              ))}
            </LimitsPanel>
          ))}
          {group.withoutLimits.map((instance) => (
            <LimitsPanel
              key={`${instance.environmentId}\n${instance.instanceId}`}
              title={instance.displayName}
              snapshot={instance.snapshot}
              detail={[instance.snapshot.status, where([instance])].filter(Boolean).join(" · ")}
              resets={resetCredits([instance])}
            >
              <Note>{instance.reason ?? "This provider has not reported usage limits."}</Note>
            </LimitsPanel>
          ))}
        </View>
      ))}
      {view.limitless.length > 0 ? (
        <Note>{`No limits reported: ${view.limitless.join(", ")}`}</Note>
      ) : null}
    </View>
  );
}
