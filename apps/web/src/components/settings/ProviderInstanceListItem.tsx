import { type KeyboardEvent } from "react";
import {
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProvider,
} from "@ryco/contracts";

import { cn } from "../../lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Badge } from "../ui/badge";
import type { DriverOption } from "./providerDriverMeta";
import { deriveProviderInstancePresentation } from "./providerInstancePresentation";
import { PROVIDER_STATUS_STYLES } from "./providerStatus";

export function ProviderInstanceListItem(props: {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driverOption: DriverOption | undefined;
  readonly liveProvider: ServerProvider | undefined;
  readonly isDefault: boolean;
  readonly selected: boolean;
  readonly editorId: string;
  readonly onSelect: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const presentation = deriveProviderInstancePresentation(props);
  const statusStyle = PROVIDER_STATUS_STYLES[presentation.statusKey];
  const FallbackIcon = props.driverOption?.icon;
  const kindLabel = props.isDefault ? "Default" : "Custom";

  return (
    <button
      type="button"
      data-settings-section={presentation.displayName}
      data-settings-action
      data-provider-instance-row
      aria-current={props.selected ? "true" : undefined}
      aria-controls={props.editorId}
      aria-label={`Edit ${presentation.displayName} ${kindLabel.toLowerCase()} provider instance`}
      className={cn(
        "group flex w-full min-w-0 cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        props.selected
          ? "border-foreground/20 bg-background shadow-sm"
          : "border-transparent hover:border-border/80 hover:bg-background/70",
      )}
      onClick={props.onSelect}
      onKeyDown={props.onKeyDown}
    >
      {presentation.driverKind ? (
        <ProviderInstanceIcon
          driverKind={presentation.driverKind}
          displayName={presentation.displayName}
          accentColor={presentation.accentColor}
          showBadge={Boolean(presentation.accentColor)}
          statusDotClassName={statusStyle.dot}
          className="mt-0.5 size-7"
          iconClassName="size-5 text-foreground/80"
        />
      ) : FallbackIcon ? (
        <span className="relative mt-0.5 inline-flex size-7 shrink-0 items-center justify-center">
          <FallbackIcon className="size-5 text-foreground/80" aria-hidden />
          <span
            className={cn(
              "pointer-events-none absolute -left-0.5 -top-0.5 size-2 rounded-full ring-2 ring-background",
              statusStyle.dot,
            )}
            aria-hidden
          />
        </span>
      ) : (
        <span className={cn("mt-2 size-2 shrink-0 rounded-full", statusStyle.dot)} />
      )}

      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">
            {presentation.displayName}
          </span>
          <Badge variant="outline" size="sm" className="shrink-0 bg-background/60">
            {kindLabel}
          </Badge>
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
          {presentation.summary.headline}
        </span>
        {!props.isDefault ? (
          <code className="mt-0.5 block truncate text-[10px] text-muted-foreground/70">
            {props.instanceId}
          </code>
        ) : null}
      </span>
    </button>
  );
}
