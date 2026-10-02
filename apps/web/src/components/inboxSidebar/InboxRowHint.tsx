import { type ComponentProps, createContext, type ReactNode, useContext } from "react";

import { type TooltipCreateHandle, TooltipTrigger } from "../ui/tooltip";

export type InboxHintHandle = ReturnType<typeof TooltipCreateHandle<ReactNode>>;

interface InboxHintContextValue {
  readonly handle: InboxHintHandle;
  /** Hints stand down while the row card is open (see InboxHoverLayer). */
  readonly disabled: boolean;
}

export const InboxHintContext = createContext<InboxHintContextValue | null>(null);

/**
 * A precise target inside an inbox row. Every hint shares one tooltip that
 * glides from target to target; hovering one names that exact thing.
 */
export function InboxHint({
  label,
  children,
  ...props
}: { readonly label: ReactNode } & ComponentProps<"span">) {
  const context = useContext(InboxHintContext);
  if (!context) return <span {...props}>{children}</span>;
  return (
    <TooltipTrigger
      closeDelay={60}
      delay={260}
      disabled={context.disabled}
      handle={context.handle}
      payload={label}
      render={<span {...props} />}
    >
      {children}
    </TooltipTrigger>
  );
}
