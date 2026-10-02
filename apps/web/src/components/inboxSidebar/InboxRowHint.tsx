import { type ComponentProps, createContext, type ReactNode, useContext } from "react";

import { type TooltipCreateHandle, TooltipTrigger } from "../ui/tooltip";

export type InboxHintHandle = ReturnType<typeof TooltipCreateHandle<ReactNode>>;

interface InboxHintContextValue {
  readonly handle: InboxHintHandle;
  /** While a hint is hovered the row's preview card stays closed. */
  readonly setPreviewSuppressed: (suppressed: boolean) => void;
}

export const InboxHintContext = createContext<InboxHintContextValue | null>(null);

/**
 * A precise target inside an inbox row (status glyph, change request, time,
 * machine). Every hint shares one tooltip that glides from target to target;
 * hovering one names that exact thing instead of opening the row's card.
 */
export function InboxHint({
  label,
  children,
  onPointerEnter,
  onPointerLeave,
  ...props
}: { readonly label: ReactNode } & ComponentProps<"span">) {
  const context = useContext(InboxHintContext);
  if (!context) {
    return (
      <span onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave} {...props}>
        {children}
      </span>
    );
  }
  return (
    <TooltipTrigger
      closeDelay={60}
      delay={260}
      handle={context.handle}
      payload={label}
      render={
        <span
          {...props}
          onPointerEnter={(event) => {
            context.setPreviewSuppressed(true);
            onPointerEnter?.(event);
          }}
          onPointerLeave={(event) => {
            context.setPreviewSuppressed(false);
            onPointerLeave?.(event);
          }}
        />
      }
    >
      {children}
    </TooltipTrigger>
  );
}
