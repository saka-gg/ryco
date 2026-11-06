import { type ProviderDriverKind, type ProviderInstanceId } from "@ryco/contracts";
import { memo } from "react";
import { StarIcon } from "lucide-react";
import {
  getDisplayModelName,
  getTriggerDisplayModelLabel,
  type ModelEsque,
  PROVIDER_ICON_BY_PROVIDER,
} from "./providerIconUtils";
import { ComboboxItem } from "../ui/combobox";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

export const ModelListRow = memo(function ModelListRow(props: {
  index: number;
  value?: string;
  effortLabel?: string | undefined;
  model: ModelEsque;
  /** Instance the model belongs to — the routing key used in combobox values. */
  instanceId: ProviderInstanceId;
  /** Driver kind of the instance — used for the provider icon glyph. */
  driverKind: ProviderDriverKind;
  /**
   * Instance name for the row's provider mark tooltip (mixed lists). Usually
   * the instance's configured `displayName` so custom instances like
   * "Codex Personal" render with their user-authored label.
   */
  providerDisplayName: string;
  providerAccentColor?: string | undefined;
  isFavorite: boolean;
  showProvider: boolean;
  preferShortName?: boolean;
  useTriggerLabel?: boolean;
  jumpLabel?: string | null;
  onToggleFavorite: () => void;
}) {
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[props.driverKind] ?? null;
  const providerLabel = props.model.subProvider
    ? `${props.providerDisplayName} · ${props.model.subProvider}`
    : props.providerDisplayName;

  const modelName = props.useTriggerLabel
    ? getTriggerDisplayModelLabel(props.model)
    : getDisplayModelName(
        props.model,
        props.preferShortName ? { preferShortName: true } : undefined,
      );
  const favoriteLabel = props.isFavorite ? "Remove from favorites" : "Add to favorites";

  // One line: [provider mark] name, detail, shortcut, star. The open tab
  // already names the instance, so only mixed lists (favorites, search) mark it.
  return (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={props.value ?? `${props.instanceId}:${props.model.slug}`}
      contentClassName="flex w-full min-w-0 items-center gap-2"
      className={cn(
        "group min-h-8 w-full cursor-pointer rounded-md py-1 ps-2 pe-1 transition-colors",
        "data-highlighted:bg-muted data-selected:bg-accent data-selected:text-foreground",
      )}
    >
      {props.showProvider && ProviderIcon ? (
        <span
          className="inline-flex shrink-0 items-center gap-1"
          title={providerLabel}
          data-model-picker-row-provider={providerLabel}
        >
          <ProviderIcon className="size-3.5 shrink-0" aria-hidden />
          {props.providerAccentColor ? (
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: props.providerAccentColor }}
              aria-hidden
            />
          ) : null}
        </span>
      ) : null}
      <span
        className="min-w-0 shrink truncate text-left text-[13px] leading-snug"
        data-model-picker-model-name=""
      >
        {modelName}
      </span>
      <span className="min-w-0 flex-1 truncate text-left text-xs text-muted-foreground/70">
        {props.effortLabel ?? (props.showProvider ? null : props.model.subProvider)}
      </span>
      {props.jumpLabel ? (
        <Kbd className="h-4 min-w-0 shrink-0 rounded-full px-1.5 text-[10px] pointer-coarse:hidden">
          {props.jumpLabel}
        </Kbd>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              className={cn(
                "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-foreground/5 hover:text-foreground",
                props.isFavorite && "text-amber-400 hover:text-amber-300",
              )}
              onClick={(event) => {
                event.stopPropagation();
                props.onToggleFavorite();
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
              }}
              type="button"
              aria-label={favoriteLabel}
            >
              <StarIcon className={cn("size-3.5", props.isFavorite && "fill-current")} />
            </button>
          }
        />
        <TooltipPopup side="top" align="center">
          {favoriteLabel}
        </TooltipPopup>
      </Tooltip>
    </ComboboxItem>
  );
});
