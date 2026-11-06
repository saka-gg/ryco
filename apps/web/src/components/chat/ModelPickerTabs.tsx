import { type ProviderInstanceId } from "@ryco/contracts";
import { type CSSProperties, memo, type ReactNode, useEffect, useMemo, useRef } from "react";
import { SparklesIcon, StarIcon } from "lucide-react";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import type { ProviderInstanceEntry } from "../../providerInstances";

const NEW_BADGE_CLASS =
  "pointer-events-none absolute -right-0.5 top-0 z-10 flex size-3.5 items-center justify-center rounded-full text-amber-600 dark:text-amber-300";

function ModelPickerTabButton(props: {
  label: string;
  /** Defaults to the label. */
  tooltip?: string;
  selected: boolean;
  /** Colors the open tab's marker: the instance's accent, so the marker points at it. */
  accentColor?: string | undefined;
  /** `data-model-picker-provider`; omitted for the settings shortcut. */
  providerKey?: string;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            aria-pressed={props.providerKey === undefined ? undefined : props.selected}
            data-model-picker-provider={props.providerKey}
            data-provider-accent-color={props.accentColor}
            {...(props.selected ? { "data-model-picker-tab-selected": "" } : {})}
            className={cn(
              "relative flex h-7 min-w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg px-1.5 text-muted-foreground/70 outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/60",
              props.selected &&
                "text-foreground after:absolute after:inset-x-1.5 after:-bottom-1 after:h-0.5 after:rounded-full after:bg-(--tab-accent,var(--color-primary))",
            )}
            style={
              props.accentColor
                ? ({ "--tab-accent": props.accentColor } as CSSProperties)
                : undefined
            }
            onClick={props.onSelect}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-64 text-balance font-normal leading-snug">
        {props.tooltip ?? props.label}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * The picker's source tabs: favorites, then one tab per set-up instance, and a
 * shortcut to provider settings that stays put however far the tabs scroll.
 */
export const ModelPickerTabs = memo(function ModelPickerTabs(props: {
  /** Null while a search spans every instance: no tab is open. */
  selectedInstanceId: ProviderInstanceId | "favorites" | null;
  onSelectInstance: (instanceId: ProviderInstanceId | "favorites") => void;
  /**
   * Set-up instance entries, one tab each keyed by `instanceId`, so the
   * built-in Codex and a user-authored `codex_personal` are two tabs with
   * their own model lists.
   */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  /** Hidden for locked-provider instance switching. */
  showFavorites?: boolean;
  /** Default built-in ids that get the "new" sparkle badge. */
  newBadgeInstanceIds?: ReadonlySet<ProviderInstanceId>;
  /** Omitted while the thread is locked to its provider. */
  onAddProviders?: (() => void) | undefined;
}) {
  const showFavorites = props.showFavorites ?? true;
  const stripRef = useRef<HTMLDivElement | null>(null);
  const duplicateDriverCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of props.instanceEntries) {
      counts.set(entry.driverKind, (counts.get(entry.driverKind) ?? 0) + 1);
    }
    return counts;
  }, [props.instanceEntries]);

  // Many instances overflow the strip: keep the open tab in view.
  const { selectedInstanceId } = props;
  useEffect(() => {
    if (selectedInstanceId === null) return;
    stripRef.current
      ?.querySelector<HTMLElement>(
        `[data-model-picker-provider="${CSS.escape(selectedInstanceId)}"]`,
      )
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedInstanceId]);

  return (
    <div
      className="flex shrink-0 items-center gap-0.5 border-b p-1.5"
      data-model-picker-tabs="true"
    >
      {/* The vertical padding leaves room for the open tab's marker, which
          hangs below the button. */}
      <div
        ref={stripRef}
        className="-my-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {showFavorites ? (
          <ModelPickerTabButton
            label="Favorites"
            providerKey="favorites"
            selected={props.selectedInstanceId === "favorites"}
            onSelect={() => props.onSelectInstance("favorites")}
          >
            <StarIcon className="size-3.5 shrink-0 fill-current" aria-hidden />
          </ModelPickerTabButton>
        ) : null}
        {props.instanceEntries.map((entry) => {
          const showNewBadge = props.newBadgeInstanceIds?.has(entry.instanceId) ?? false;
          const showInstanceBadge =
            Boolean(entry.accentColor) || (duplicateDriverCounts.get(entry.driverKind) ?? 0) > 1;
          return (
            <ModelPickerTabButton
              key={entry.instanceId}
              label={showNewBadge ? `${entry.displayName}, new` : entry.displayName}
              tooltip={showNewBadge ? `${entry.displayName} — New` : entry.displayName}
              providerKey={entry.instanceId}
              selected={props.selectedInstanceId === entry.instanceId}
              accentColor={entry.accentColor}
              onSelect={() => props.onSelectInstance(entry.instanceId)}
            >
              <ProviderInstanceIcon
                driverKind={entry.driverKind}
                displayName={entry.displayName}
                accentColor={entry.accentColor}
                showBadge={showInstanceBadge}
                className="size-5 text-foreground"
                iconClassName="size-4"
              />
              {showNewBadge ? (
                <span className={NEW_BADGE_CLASS} aria-hidden>
                  <SparklesIcon className="size-2" />
                </span>
              ) : null}
            </ModelPickerTabButton>
          );
        })}
      </div>
      {props.onAddProviders ? (
        <ModelPickerTabButton
          label="Add providers"
          selected={false}
          onSelect={props.onAddProviders}
        >
          {/* Inline: a lucide icon new to this chunk would regroup the shared icon chunks. */}
          <svg
            viewBox="0 0 24 24"
            className="size-3.5 shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            aria-hidden
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </ModelPickerTabButton>
      ) : null}
    </div>
  );
});
