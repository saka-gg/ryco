import type { ProviderOptionSelection } from "@ryco/contracts";
import {
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@ryco/contracts";
import { memo, useEffect, useMemo, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import { ChevronDownIcon } from "lucide-react";
import { Button, buttonVariants } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { ModelPickerContent } from "./ModelPickerContent";
import { PhoneModelSheet } from "./PhoneModelSheet";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import {
  ModelEsque,
  getTriggerDisplayModelLabel,
  getTriggerDisplayModelName,
} from "./providerIconUtils";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import { boundedDisabledReason } from "~/lib/boundedReason";
import { setModelPickerOpen } from "../../modelPickerOpenState";
import type { ProviderInstanceEntry } from "../../providerInstances";

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  /**
   * The instance currently selected in the composer. Drives the trigger
   * icon, label and the default-highlighted combobox row.
   */
  activeInstanceId: ProviderInstanceId;
  model: string;
  modelOptions?: ReadonlyArray<ProviderOptionSelection> | undefined;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  /** Instance entries rendered in the sidebar + used to resolve display name. */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  activeProviderIconClassName?: string;
  compact?: boolean;
  openOnHover?: boolean;
  /**
   * Opt in to the phone-tier bottom sheet.
   *
   * The picker is a reusable control with several call sites, and only the
   * composer's model pill is the phone surface the design gives a sheet; the
   * settings panel's text-generation picker is a desktop-shaped form row. So
   * the presentation is a call-site decision rather than something derived from
   * the tier alone — a call site that does not opt in keeps the two-pane
   * popover on every tier, unchanged.
   */
  phoneSheet?: boolean;
  /**
   * Renders the disabled presentation and blocks every selection. Production
   * call sites pass the read-only mutation capability's negation here rather
   * than sensing connectivity themselves.
   */
  disabled?: boolean;
  /**
   * Bounded, operator-facing reason shown by the phone sheet when `disabled`.
   * Never a raw error, identifier, ticket, or payload.
   */
  disabledReason?: string;
  terminalOpen?: boolean;
  open?: boolean;
  triggerSize?: VariantProps<typeof buttonVariants>["size"];
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  onOpenChange?: (open: boolean) => void;
  onInstanceModelChange: (
    instanceId: ProviderInstanceId,
    model: string,
    options?: ReadonlyArray<ProviderOptionSelection>,
  ) => void;
}) {
  const [uncontrolledIsMenuOpen, setUncontrolledIsMenuOpen] = useState(false);
  const isMenuOpen = props.open ?? uncontrolledIsMenuOpen;
  // A call site that opted in gets a bottom sheet on the phone tier instead of
  // the two-pane popover. The desktop popover, its search autofocus, and its
  // keyboard navigation are untouched: `ModelPickerContent` simply never mounts
  // in the sheet branch, and the sheet never mounts on the desktop tier.
  const isPhoneTier = usePresentationTier() === "phone";
  const useSheet = (props.phoneSheet ?? false) && isPhoneTier;

  // Resolve the active instance entry by exact routing key. The composer
  // resolves fallbacks before rendering this component; if the selected
  // instance disappears, do not infer a replacement from its driver kind.
  const activeEntry = useMemo(() => {
    return (
      props.instanceEntries.find((entry) => entry.instanceId === props.activeInstanceId) ?? null
    );
  }, [props.activeInstanceId, props.instanceEntries]);

  const activeInstanceId = props.activeInstanceId;
  const selectedInstanceOptions = props.modelOptionsByInstance.get(activeInstanceId) ?? [];
  // If the current slug belongs to a different instance (for example after
  // a provider switch or disable), prefer the active instance's first
  // option so the trigger icon and label stay in sync instead of showing
  // a stale foreign slug.
  const selectedModel =
    selectedInstanceOptions.find((option) => option.slug === props.model) ??
    selectedInstanceOptions[0];
  const triggerTitle = selectedModel ? getTriggerDisplayModelName(selectedModel) : props.model;
  const triggerSubtitle = selectedModel?.isUnavailable ? "Unavailable" : selectedModel?.subProvider;
  const triggerLabel = selectedModel ? getTriggerDisplayModelLabel(selectedModel) : props.model;
  const duplicateDriverCount = props.instanceEntries.filter(
    (entry) => activeEntry !== null && entry.driverKind === activeEntry.driverKind,
  ).length;
  const showInstanceBadge = Boolean(activeEntry?.accentColor) || duplicateDriverCount > 1;

  const setIsMenuOpen = (open: boolean) => {
    props.onOpenChange?.(open);
    if (props.open === undefined) {
      setUncontrolledIsMenuOpen(open);
    }
  };

  useEffect(() => {
    setModelPickerOpen(isMenuOpen);
    return () => {
      setModelPickerOpen(false);
    };
  }, [isMenuOpen]);

  const handleInstanceModelChange = (
    instanceId: ProviderInstanceId,
    model: string,
    options?: ReadonlyArray<ProviderOptionSelection>,
  ) => {
    if (props.disabled) return;
    if (options) props.onInstanceModelChange(instanceId, model, options);
    else props.onInstanceModelChange(instanceId, model);
    setIsMenuOpen(false);
  };

  // Bounded before it reaches a `title`, so an unavailability reason can never
  // carry a raw error, identifier, ticket, or payload into the DOM.
  const disabledReasonTitle =
    props.disabled && props.disabledReason
      ? boundedDisabledReason(props.disabledReason)
      : undefined;

  const triggerButtonClassName = cn(
    "min-w-0 justify-start overflow-hidden whitespace-nowrap px-1.5 text-muted-foreground/70 hover:text-foreground/80 [&_svg]:mx-0",
    props.compact ? "max-w-38 shrink-0 sm:max-w-40" : "max-w-44 shrink sm:max-w-52 sm:px-2",
    props.triggerClassName,
  );

  // The trigger's contents are identical on both tiers — only what the trigger
  // opens differs — so they are built once rather than duplicated.
  const triggerContent = (
    <span
      className={cn(
        "flex min-w-0 w-full box-border items-center gap-1.5 overflow-hidden",
        props.compact ? "max-w-34 sm:pl-0.5" : undefined,
      )}
    >
      {activeEntry ? (
        <ProviderInstanceIcon
          driverKind={activeEntry.driverKind}
          displayName={activeEntry.displayName}
          accentColor={activeEntry.accentColor}
          showBadge={showInstanceBadge}
          className={showInstanceBadge ? "size-5" : "size-4"}
          iconClassName={cn("size-4", props.activeProviderIconClassName)}
          badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 text-[7px]"
        />
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className={cn(
                "min-w-0 flex-1 overflow-hidden",
                triggerSubtitle
                  ? "grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1"
                  : "truncate",
              )}
            />
          }
        >
          {triggerSubtitle ? (
            <>
              <span className="min-w-0 truncate">{triggerSubtitle}</span>
              <span aria-hidden="true" className="shrink-0 opacity-60">
                ·
              </span>
              <span className="min-w-0 truncate">{triggerTitle}</span>
            </>
          ) : (
            triggerTitle
          )}
        </TooltipTrigger>
        <TooltipPopup side="top">{triggerLabel}</TooltipPopup>
      </Tooltip>
      <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
    </span>
  );

  if (useSheet) {
    return (
      <>
        <Button
          size={props.triggerSize ?? "sm"}
          variant={props.triggerVariant ?? "ghost"}
          data-chat-provider-model-picker="true"
          // A REAL 44px border box, not the `Button` coarse-pointer hit slop.
          // Measured: the slop is a `::after` on a `relative` button that this
          // trigger also makes `overflow-hidden`, so the button is its own
          // containing block AND clips it — the effective target was 28px
          // (`h-7`; the `sm:h-6` step never applies below 640px). Making the
          // slop visible only recovers 30px, because the composer's control row
          // is `overflow-x-auto`, which forces the block axis to `auto` and
          // clips the rest. Sizing the box itself is the only fix that does not
          // depend on a pseudo-element surviving two ancestors' overflow.
          className={cn(triggerButtonClassName, "min-h-11 min-w-11")}
          disabled={props.disabled}
          title={disabledReasonTitle}
          onClick={() => setIsMenuOpen(true)}
        >
          {triggerContent}
        </Button>
        <PhoneModelSheet
          open={isMenuOpen}
          onOpenChange={setIsMenuOpen}
          activeInstanceId={activeInstanceId}
          model={props.model}
          lockedProvider={props.lockedProvider}
          lockedContinuationGroupKey={props.lockedContinuationGroupKey ?? null}
          instanceEntries={props.instanceEntries}
          modelOptionsByInstance={props.modelOptionsByInstance}
          disabled={props.disabled ?? false}
          {...(props.disabledReason ? { disabledReason: props.disabledReason } : {})}
          onInstanceModelChange={handleInstanceModelChange}
        />
      </>
    );
  }

  return (
    <Popover
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
    >
      <PopoverTrigger
        openOnHover={props.openOnHover ?? false}
        delay={150}
        closeDelay={200}
        render={
          <Button
            size={props.triggerSize ?? "sm"}
            variant={props.triggerVariant ?? "ghost"}
            data-chat-provider-model-picker="true"
            className={triggerButtonClassName}
            disabled={props.disabled}
            title={disabledReasonTitle}
          />
        }
      >
        {triggerContent}
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        className="border-0 bg-transparent p-0 shadow-none before:hidden [--viewport-inline-padding:0] *:data-[slot=popover-viewport]:p-0"
      >
        <ModelPickerContent
          modelOptions={props.modelOptions}
          activeInstanceId={activeInstanceId}
          model={props.model}
          lockedProvider={props.lockedProvider}
          lockedContinuationGroupKey={props.lockedContinuationGroupKey ?? null}
          instanceEntries={props.instanceEntries}
          {...(props.keybindings ? { keybindings: props.keybindings } : {})}
          modelOptionsByInstance={props.modelOptionsByInstance}
          terminalOpen={props.terminalOpen ?? false}
          onRequestClose={() => setIsMenuOpen(false)}
          onInstanceModelChange={handleInstanceModelChange}
        />
      </PopoverPopup>
    </Popover>
  );
});
