import type { ContextHandoffEndpointSnapshot } from "@ryco/contracts";
import type { ContextHandoffEndpointLabelers } from "../../session-logic";
import { memo } from "react";

import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { cn } from "~/lib/utils";

const BUILT_IN_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  codex: "Codex",
  claudeAgent: "Claude",
  copilot: "GitHub Copilot",
  opencode: "OpenCode",
  cursor: "Cursor",
  grok: "Grok",
};

export function contextHandoffProviderLabel(endpoint: ContextHandoffEndpointSnapshot): string {
  return (
    endpoint.providerDisplayName ??
    BUILT_IN_PROVIDER_LABELS[endpoint.driverKind] ??
    endpoint.providerInstanceId
  );
}

export function contextHandoffModelLabel(endpoint: ContextHandoffEndpointSnapshot): string {
  return endpoint.modelDisplayName ?? endpoint.modelSlug;
}

export function contextHandoffEndpointAccessibleLabel(
  endpoint: ContextHandoffEndpointSnapshot,
): string {
  return `${contextHandoffProviderLabel(endpoint)} ${contextHandoffModelLabel(endpoint)}`;
}

/** The web's endpoint labels for the shared fork divider rule (`forkHandoffEndpointLabels`). */
export const CONTEXT_HANDOFF_ENDPOINT_LABELERS: ContextHandoffEndpointLabelers = {
  endpoint: contextHandoffEndpointAccessibleLabel,
  model: contextHandoffModelLabel,
};

export const ContextHandoffEndpointLabel = memo(function ContextHandoffEndpointLabel(props: {
  endpoint: ContextHandoffEndpointSnapshot;
  className?: string;
  iconClassName?: string;
  modelClassName?: string;
}) {
  const configuredProviderLabel = props.endpoint.providerDisplayName;
  const builtInProviderLabel = BUILT_IN_PROVIDER_LABELS[props.endpoint.driverKind];
  const displayProviderLabel = contextHandoffProviderLabel(props.endpoint);
  const accessibleLabel = contextHandoffEndpointAccessibleLabel(props.endpoint);

  return (
    <span
      className={cn("inline-flex min-w-0 items-center gap-1", props.className)}
      title={accessibleLabel}
    >
      <ProviderInstanceIcon
        driverKind={props.endpoint.driverKind}
        displayName={displayProviderLabel}
        accentColor={props.endpoint.providerAccentColor}
        showBadge={
          configuredProviderLabel !== undefined && configuredProviderLabel !== builtInProviderLabel
        }
        className="size-4"
        iconClassName={cn("size-3.5", props.iconClassName)}
        badgeClassName="h-2.5 min-w-2.5 text-[6px]"
      />
      <span className={cn("truncate", props.modelClassName)}>
        {contextHandoffModelLabel(props.endpoint)}
      </span>
    </span>
  );
});
