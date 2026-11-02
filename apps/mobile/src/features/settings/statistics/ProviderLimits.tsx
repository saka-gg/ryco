import { CodexResetCredits } from "./CodexResetCredits";
import type { EnvironmentId, ServerProvider, ServerProviderRateLimitWindow } from "@ryco/contracts";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AppState, View } from "react-native";
import {
  availablePercent,
  describeRateLimitPace,
  nextLimitResetAtMs,
  rateLimitPace,
  rateLimitsObservedAt,
  staleRateLimitsReason,
  type DirectAccountLocation,
  type PooledLimitWindow,
} from "@ryco/client-runtime/usage";
import { AppText as Text } from "../../../components/AppText";
import { ProviderIcon } from "../../../components/ProviderIcon";
import { Note, Panel, Row } from "./StatisticsParts";
import {
  deriveProviderLimitsView,
  type HubAccountRow,
  type ProviderLimitsNode,
} from "./providerLimitsModel";

export type { ProviderLimitsNode } from "./providerLimitsModel";

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

/** A window several hub accounts share: their mean use, and the soonest reset among them. */
function PooledWindow({
  window,
  besideDirect,
}: {
  window: PooledLimitWindow;
  /** Direct accounts share the group; the pool averages hub accounts only, so it says so. */
  besideDirect: boolean;
}) {
  const reset = window.nextResetsAt ? new Date(window.nextResetsAt * 1000) : null;
  return (
    <View className="gap-1">
      <Row
        label={`${window.label} · avg of ${window.accountCount} ${besideDirect ? "hub accounts" : "accounts"}`}
        value={`${Math.round(100 - window.usedPercent)}% left`}
      />
      {reset && Number.isFinite(reset.getTime()) ? (
        <Note>Next reset {reset.toLocaleString()}</Note>
      ) : null}
    </View>
  );
}

/** One account a CLIProxyAPI hub pools: its name (never an email), plan and hub, then its limits. */
function HubAccountPanel({ row, now }: { row: HubAccountRow; now: number }) {
  return (
    <Panel title={row.name}>
      <View className="flex-row items-center gap-3">
        <ProviderIcon provider={row.driver} size={22} />
        <View className="flex-1">
          <Text className="text-sm text-foreground-secondary">{row.detail}</Text>
          <Note>{`Checked ${new Date(row.checkedAt).toLocaleString()}`}</Note>
        </View>
      </View>
      {row.windows.map(({ id, label, window }) => (
        <LimitWindow
          key={id}
          label={label}
          window={window}
          checkedAt={row.checkedAt}
          available={row.available}
          now={now}
        />
      ))}
      {row.notes.map((note) => (
        <Note key={note}>{note}</Note>
      ))}
    </Panel>
  );
}

/** One account or instance: icon, plan or status, devices, last check or read, then its limits. */
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
  const staleReason = staleRateLimitsReason(limits);
  return (
    <Panel title={title}>
      <View className="flex-row items-center gap-3">
        <ProviderIcon provider={snapshot.driver} size={22} />
        <View className="flex-1">
          <Text className="text-sm text-foreground-secondary">{detail}</Text>
          <Note>
            {staleReason
              ? `Usage from ${new Date(rateLimitsObservedAt(snapshot)).toLocaleString()}; ${staleReason}.`
              : `Checked ${new Date(snapshot.checkedAt).toLocaleString()}`}
          </Note>
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
 * Provider limits across devices, through the same shared selectors as the web Limits page: each
 * direct account once and every account a CLIProxyAPI hub pools, grouped by provider.
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
  const [now, setNow] = useState(Date.now);
  // Read the clock again as soon as a snapshot changes, so a live push never looks future-dated
  // to pace and a hub's cooldown is judged against the time it answered.
  useEffect(() => {
    if (nodes.length === 0) return;
    const timer = setTimeout(() => setNow(Date.now()), 0);
    return () => clearTimeout(timer);
  }, [nodes]);
  const view = useMemo(() => deriveProviderLimitsView(nodes, now), [nodes, now]);
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
        Account limits reported by each provider and CLIProxyAPI hub. These allowances may be shared
        with other apps and devices.
      </Note>
      {view.notices.map((notice) => (
        <Panel key={notice.key} title={notice.title}>
          <Note>{notice.message}</Note>
        </Panel>
      ))}
      {view.empty ? (
        <Note>No enabled providers on {nodes.length === 1 ? "this device" : "these devices"}.</Note>
      ) : null}
      {view.groups.map((group) => (
        <View key={group.provider} className="gap-3">
          <Text className="text-lg font-ryco-bold text-foreground">{group.label}</Text>
          {group.pooled.length > 0 ? (
            <Panel title="Pooled">
              {group.pooled.map((window) => (
                <PooledWindow
                  key={window.id}
                  window={window}
                  besideDirect={group.directAccounts.length > 0}
                />
              ))}
              <Note>Plans of different sizes count equally in the average.</Note>
            </Panel>
          ) : null}
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
                  checkedAt={rateLimitsObservedAt(account.snapshot)}
                  available={account.available}
                  now={now}
                />
              ))}
              {view.alsoInHubs.has(account.key) ? (
                <Note>{view.alsoInHubs.get(account.key)}</Note>
              ) : null}
            </LimitsPanel>
          ))}
          {group.hubAccounts.map((row) => (
            <HubAccountPanel key={row.key} row={row} now={now} />
          ))}
          {group.withoutLimits.map((instance) => (
            <LimitsPanel
              key={`${instance.environmentId}\n${instance.instanceId}`}
              title={instance.displayName}
              snapshot={instance.snapshot}
              detail={[instance.plan ?? instance.snapshot.status, where([instance])]
                .filter(Boolean)
                .join(" · ")}
              resets={resetCredits([instance])}
            >
              <Note>{instance.reason ?? "This provider has not reported usage limits."}</Note>
            </LimitsPanel>
          ))}
          {group.routed.map((note) => (
            <Note key={note}>{note}</Note>
          ))}
        </View>
      ))}
      {view.routed.map((note) => (
        <Note key={note}>{note}</Note>
      ))}
      {view.limitless.length > 0 ? (
        <Note>{`No limits reported: ${view.limitless.join(", ")}`}</Note>
      ) : null}
    </View>
  );
}
