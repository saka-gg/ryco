import { View } from "react-native";
import type { ServerProvider, ServerProviderRateLimitWindow } from "@ryco/contracts";
import { availablePercent, describeRateLimitWindow } from "@ryco/client-runtime/usage";
import { AppText as Text } from "../../../components/AppText";
import { ProviderIcon } from "../../../components/ProviderIcon";
import { Note, Panel, Row } from "./StatisticsParts";

function LimitWindow({
  window,
  fallback,
}: {
  window: ServerProviderRateLimitWindow;
  fallback: string;
}) {
  const valid = Number.isFinite(window.usedPercent);
  const remaining = availablePercent(window.usedPercent);
  const cadence = describeRateLimitWindow(window).label;
  const reset = window.resetsAt ? new Date(window.resetsAt * 1000) : null;
  return (
    <View className="gap-2">
      <Row
        label={cadence === "Window" ? fallback : cadence}
        value={valid ? `${Math.round(remaining)}% left` : "Unavailable"}
      />
      <View className="h-1.5 overflow-hidden rounded-full bg-card-alt">
        <View
          style={{
            width: `${valid ? remaining : 0}%`,
            height: 6,
            borderRadius: 3,
            backgroundColor: remaining <= 10 ? "#ef4444" : remaining <= 25 ? "#f59e0b" : "#22c55e",
          }}
        />
      </View>
      {reset && Number.isFinite(reset.getTime()) ? (
        <Note>Resets {reset.toLocaleString()}</Note>
      ) : null}
    </View>
  );
}
export function ProviderLimits({ providers }: { providers: readonly ServerProvider[] }) {
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
              <LimitWindow window={limits.primary} fallback="Short window" />
            ) : null}
            {limits?.secondary ? <LimitWindow window={limits.secondary} fallback="Weekly" /> : null}
            {limits?.tertiary ? <LimitWindow window={limits.tertiary} fallback="Monthly" /> : null}
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
