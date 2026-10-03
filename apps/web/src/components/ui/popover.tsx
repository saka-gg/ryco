"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { cn } from "~/lib/utils";
import {
  MORPH_SURFACE_ATTRIBUTE,
  POPOVER_MORPH_POPUP_CLASS_NAME,
  POPOVER_MORPH_PROFILE,
  type AttachSurfaceMorphOptions,
  type SurfaceMorphProp,
  useSurfaceMorphRef,
} from "./surfaceMorph";

const PopoverCreateHandle = PopoverPrimitive.createHandle;

const Popover = PopoverPrimitive.Root;

function PopoverTrigger({ className, children, ...props }: PopoverPrimitive.Trigger.Props) {
  return (
    <PopoverPrimitive.Trigger className={className} data-slot="popover-trigger" {...props}>
      {children}
    </PopoverPrimitive.Trigger>
  );
}

/**
 * Where a morphing popover's ghost lives: beside the positioner (which may be
 * transformed, so a fixed ghost inside it would be offset), at its z-index and
 * just before it in DOM order so the popup paints over the ghost. The surface
 * is the descendant marked `data-morph-surface` when the popup itself is
 * transparent chrome around a custom panel (the model picker).
 */
function popoverMorphHost(popup: HTMLElement): Omit<AttachSurfaceMorphOptions, "profile"> {
  const surface = popup.querySelector<HTMLElement>(`[${MORPH_SURFACE_ATTRIBUTE}]`) ?? popup;
  const positioner = popup.closest<HTMLElement>('[data-slot="popover-positioner"]');
  if (!positioner?.parentElement) return { surface, deferToNextFrame: true };
  return {
    surface,
    deferToNextFrame: true,
    ghostHost: {
      parent: positioner.parentElement,
      before: positioner,
      zIndex: getComputedStyle(positioner).zIndex,
    },
  };
}

function PopoverPopup({
  children,
  className,
  side = "bottom",
  align = "center",
  sideOffset = 4,
  alignOffset = 0,
  tooltipStyle = false,
  surface = "default",
  anchor,
  viewportClassName,
  morph,
  ref,
  ...props
}: PopoverPrimitive.Popup.Props & {
  side?: PopoverPrimitive.Positioner.Props["side"];
  align?: PopoverPrimitive.Positioner.Props["align"];
  sideOffset?: PopoverPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: PopoverPrimitive.Positioner.Props["alignOffset"];
  tooltipStyle?: boolean;
  surface?: "default" | "glass";
  anchor?: PopoverPrimitive.Positioner.Props["anchor"];
  /**
   * Overrides the inner viewport's padding. The viewport, not the popup, owns
   * the content inset, so `className="p-0"` alone cannot flush content to the
   * edges — list-style popovers whose rows carry their own padding need this.
   */
  viewportClassName?: string;
  /** Grow out of (and fold back into) a control; see `surfaceMorph.ts`. */
  morph?: SurfaceMorphProp;
}) {
  const popupRef = useSurfaceMorphRef(morph, ref, {
    profile: POPOVER_MORPH_PROFILE,
    resolveHost: popoverMorphHost,
  });
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        className="z-50 h-(--positioner-height) w-(--positioner-width) max-w-(--available-width) transition-[top,left,right,bottom,transform] data-instant:transition-none"
        data-slot="popover-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <PopoverPrimitive.Popup
          className={cn(
            "relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) rounded-lg border text-popover-foreground outline-none transition-[width,height,scale,opacity] duration-(--app-motion-duration-pop) ease-(--app-motion-spring-gentle) data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0",
            surface === "glass"
              ? "selection-glass-surface"
              : "app-surface not-dark:bg-clip-padding shadow-lg/5 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] has-data-[slot=calendar]:rounded-xl has-data-[slot=calendar]:before:rounded-[calc(var(--radius-xl)-1px)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
            tooltipStyle &&
              cn(
                "w-fit text-balance rounded-md text-xs",
                surface === "default" && "shadow-md/5 before:rounded-[calc(var(--radius-md)-1px)]",
              ),
            morph && POPOVER_MORPH_POPUP_CLASS_NAME,
            className,
          )}
          data-slot="popover-popup"
          ref={popupRef}
          {...props}
        >
          <PopoverPrimitive.Viewport
            className={cn(
              "relative size-full max-h-(--available-height) overflow-clip px-(--viewport-inline-padding) py-4 [--viewport-inline-padding:--spacing(4)] has-data-[slot=calendar]:p-2 data-instant:transition-none **:data-current:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-previous:data-ending-style:opacity-0 **:data-previous:data-starting-style:opacity-0 **:data-current:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-current:opacity-100 **:data-previous:opacity-100 **:data-current:transition-opacity **:data-previous:transition-opacity",
              tooltipStyle
                ? "py-1 [--viewport-inline-padding:--spacing(2)]"
                : "not-data-transitioning:overflow-y-auto",
              viewportClassName,
            )}
            data-slot="popover-viewport"
          >
            {children}
          </PopoverPrimitive.Viewport>
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

function PopoverClose({ ...props }: PopoverPrimitive.Close.Props) {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return (
    <PopoverPrimitive.Title
      className={cn("font-semibold text-lg leading-none", className)}
      data-slot="popover-title"
      {...props}
    />
  );
}

function PopoverDescription({ className, ...props }: PopoverPrimitive.Description.Props) {
  return (
    <PopoverPrimitive.Description
      className={cn("text-muted-foreground text-sm", className)}
      data-slot="popover-description"
      {...props}
    />
  );
}

export {
  PopoverCreateHandle,
  Popover,
  PopoverTrigger,
  PopoverPopup,
  PopoverPopup as PopoverContent,
  PopoverTitle,
  PopoverDescription,
  PopoverClose,
};
