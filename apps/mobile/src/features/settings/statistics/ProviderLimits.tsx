import { useEffect, useState } from "react";
import { AppState, View } from "react-native";
import type { ServerProvider, ServerProviderRateLimitWindow } from "@ryco/contracts";
import {
  availablePercent,
  describeRateLimitWindow,
  describeRateLimitPace,
  rateLimitPace,
  isRateLimitSnapshotAvailable,
} from "@ryco/client-runtime/usage";
import { AppText as Text } from "../../../components/AppText";
import { ProviderIcon } from "../../../components/ProviderIcon";
import { Note, Panel, Row } from "./StatisticsParts";

function LimitWindow({
  window,
  fallback,
  checkedAt,
  available,
  now,
}: {
  window: ServerProviderRateLimitWindow;
  fallback: string;
  checkedAt: string;
  available: boolean;
  now: number;
}) {
  const remaining = availablePercent(window.usedPercent);
  const pace = describeRateLimitPace(rateLimitPace(window, checkedAt, now, available));
  const cadence = describeRateLimitWindow(window).label;
  const reset = window.resetsAt ? new Date(window.resetsAt * 1000) : null;
  return (
    <View className="gap-2">
      <Row
        label={cadence === "Window" ? fallback : cadence}
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
export function ProviderLimits({
  providers,
  connected,
}: {
  providers: readonly ServerProvider[];
  connected: boolean;
}) {
  const [clock, setNow] = useState(Date.now);
  const now = clock;
  useEffect(() => {
    if (providers.length === 0) return;
    const timer = setTimeout(() => setNow(Date.now()), 0);
    return () => clearTimeout(timer);
  }, [providers]);
  // One wakeup at the next reset, plus foreground recovery. No provider polling.
  useEffect(() => {
    const update = () => setNow(Date.now());
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") update();
    });
    const currentTime = Math.max(clock, Date.now());
    const resets = providers
      .flatMap((provider) =>
        [
          provider.rateLimits?.primary,
          provider.rateLimits?.secondary,
          provider.rateLimits?.tertiary,
        ].flatMap((window) => (window?.resetsAt ? [window.resetsAt * 1000] : [])),
      )
      .filter((reset) => Number.isFinite(reset) && reset > currentTime);
    const next = Math.min(...resets);
    const timer = Number.isFinite(next)
      ? setTimeout(update, Math.min(Math.max(0, next - Date.now()), 2_147_483_647))
      : undefined;
    return () => {
      subscription.remove();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [providers, clock]);
  const enabled = providers.filter((provider) => provider.enabled);
  return (
    <View className="gap-4">
      <Note>
        Account limits reported by each provider. These allowances may be shared with other apps and
        devices.
      </Note>
      {enabled.length === 0 ? <Note>No enabled providers on this device.</Note> : null}
      {enabled.map((provider) => {
        const limits = provider.rateLimits;
        return (
          <Panel key={provider.instanceId} title={provider.displayName ?? provider.driver}>
            <View className="flex-row items-center gap-3">
              <ProviderIcon provider={provider.driver} size={22} />
              <View className="flex-1">
                <Text className="text-sm text-foreground-secondary">
                  {limits?.planType ?? provider.status}
                </Text>
                <Note>Checked {new Date(provider.checkedAt).toLocaleString()}</Note>
              </View>
            </View>
            {limits?.primary ? (
              <LimitWindow
                available={isRateLimitSnapshotAvailable(provider, connected)}
                checkedAt={provider.checkedAt}
                now={now}
                window={limits.primary}
                fallback="Short window"
              />
            ) : null}
            {limits?.secondary ? (
              <LimitWindow
                available={isRateLimitSnapshotAvailable(provider, connected)}
                checkedAt={provider.checkedAt}
                now={now}
                window={limits.secondary}
                fallback="Weekly"
              />
            ) : null}
            {limits?.tertiary ? (
              <LimitWindow
                available={isRateLimitSnapshotAvailable(provider, connected)}
                checkedAt={provider.checkedAt}
                now={now}
                window={limits.tertiary}
                fallback="Monthly"
              />
            ) : null}
            {!limits?.primary && !limits?.secondary && !limits?.tertiary ? (
              <Note>
                {provider.unavailableReason ??
                  provider.message ??
                  "This provider has not reported usage limits."}
              </Note>
            ) : null}
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
      })}
    </View>
  );
}
