import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { PREFERS_REDUCED_MOTION_QUERY } from "~/lib/perf/motion";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";

const DISMISS_TRANSITION_MS = 220;
const frontExitStyle = {
  opacity: 0,
  transform: "translate3d(0, 4rem, 0)",
} satisfies CSSProperties;
const stackedExitStyle = {
  opacity: 0,
  transform: "translate3d(0, 7rem, 0)",
} satisfies CSSProperties;
const restingStyle = {
  opacity: 1,
  transform: "translate3d(0, 0, 0)",
} satisfies CSSProperties;
const exitTransitionStyle = {
  transition: `transform ${DISMISS_TRANSITION_MS}ms ease-in, opacity ${DISMISS_TRANSITION_MS}ms ease-in`,
  willChange: "transform, opacity",
} satisfies CSSProperties;

export interface ComposerBannerStackItem {
  readonly id: string;
  readonly variant: "error" | "info" | "success" | "warning";
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly dismissLabel?: string;
  readonly onDismiss?: () => void;
}

interface ComposerBannerStackProps {
  readonly className?: string;
  readonly items: ReadonlyArray<ComposerBannerStackItem>;
}

export function ComposerBannerStack({ className, items }: ComposerBannerStackProps) {
  const [exitingItemId, setExitingItemId] = useState<string | null>(null);
  // Touch path for the hover-revealed stack: on coarse pointers the stack cap
  // becomes a button that expands the hidden banners; fine pointers keep the
  // original decorative cap and hover/focus reveal unchanged.
  const isCoarsePointer = useMediaQuery({ pointer: "coarse" });
  // Reduced motion drops the translate/opacity exit animation entirely (the
  // dismissal itself never depends on the animation — it runs on a timer).
  const prefersReducedMotion = useMediaQuery(PREFERS_REDUCED_MOTION_QUERY);
  const [isStackExpanded, setIsStackExpanded] = useState(false);
  const dismissTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (exitingItemId && !items.some((item) => item.id === exitingItemId)) {
      setExitingItemId(null);
    }
  }, [exitingItemId, items]);

  useEffect(() => {
    if (items.length <= 1 || !isCoarsePointer) {
      setIsStackExpanded(false);
    }
  }, [isCoarsePointer, items.length]);

  useEffect(() => {
    return () => {
      if (dismissTimeoutRef.current) {
        clearTimeout(dismissTimeoutRef.current);
      }
    };
  }, []);

  if (items.length === 0) {
    return null;
  }

  const frontItem = items[0];
  if (!frontItem) {
    return null;
  }
  const stackedItems = items.slice(1);
  const hasStack = stackedItems.length > 0;
  const showCollapsedStackCap = hasStack && exitingItemId !== frontItem.id;

  const requestDismiss = (item: ComposerBannerStackItem) => {
    if (!item.onDismiss || exitingItemId) {
      return;
    }
    setExitingItemId(item.id);
    if (dismissTimeoutRef.current) {
      clearTimeout(dismissTimeoutRef.current);
    }
    dismissTimeoutRef.current = setTimeout(
      () => {
        dismissTimeoutRef.current = null;
        item.onDismiss?.();
      },
      prefersReducedMotion ? 0 : DISMISS_TRANSITION_MS,
    );
  };
  const activeExitTransitionStyle = prefersReducedMotion ? undefined : exitTransitionStyle;

  return (
    <div className={cn("group/banner-stack mx-auto mb-2 max-w-208", className)}>
      <div
        className={cn(
          "relative",
          hasStack ? "group-hover/banner-stack:z-50 group-focus-within/banner-stack:z-50" : null,
          hasStack && isStackExpanded ? "z-50" : null,
        )}
      >
        {showCollapsedStackCap ? (
          isCoarsePointer ? (
            <button
              type="button"
              data-composer-banner-stack-cap="true"
              aria-expanded={isStackExpanded}
              aria-label={
                isStackExpanded
                  ? "Hide stacked notifications"
                  : `Show ${stackedItems.length} more ${
                      stackedItems.length === 1 ? "notification" : "notifications"
                    }`
              }
              className={cn(
                // z-0 keeps the revealed stack (z-20) above the cap so taps on
                // the lowest banner are never intercepted. The after pseudo
                // extends the 12px cap to a >=44px effective touch target; it
                // reaches only 6px into the front banner, whose controls sit
                // below the alert's 12px top padding.
                "absolute inset-x-0 -top-3 z-0 mx-auto h-3 cursor-pointer rounded-t-xl",
                "after:absolute after:inset-x-0 after:-top-7 after:-bottom-1.5",
                "outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "border border-b-0 border-warning/24 bg-background/96 shadow-[0_6px_18px_rgba(0,0,0,0.06)]",
              )}
              style={{ width: "96%" }}
              onClick={() => setIsStackExpanded((expanded) => !expanded)}
            />
          ) : (
            <div
              data-composer-banner-stack-cap="true"
              className={cn(
                "pointer-events-none absolute inset-x-0 -top-3 z-0 mx-auto h-3 rounded-t-xl",
                "border border-b-0 border-warning/24 bg-background/96 shadow-[0_6px_18px_rgba(0,0,0,0.06)]",
                "transition-opacity duration-150 ease-out motion-reduce:transition-none",
                "group-hover/banner-stack:opacity-0 group-focus-within/banner-stack:opacity-0",
              )}
              style={{ width: "96%" }}
              aria-hidden="true"
            />
          )
        ) : null}
        <div
          className={cn(
            "relative z-10",
            exitingItemId === frontItem.id ? "pointer-events-none" : null,
          )}
          style={{
            ...activeExitTransitionStyle,
            ...(exitingItemId === frontItem.id ? frontExitStyle : restingStyle),
          }}
        >
          <ComposerBannerStackAlert
            item={frontItem}
            exiting={exitingItemId === frontItem.id}
            onDismissRequest={() => requestDismiss(frontItem)}
          />
        </div>
        {hasStack ? (
          <div
            data-composer-banner-stack-rest="true"
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-[calc(100%+0.5rem)] z-20 space-y-2 opacity-0",
              "transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none motion-reduce:translate-y-0",
              "translate-y-1",
              "group-hover/banner-stack:pointer-events-auto group-hover/banner-stack:translate-y-0 group-hover/banner-stack:opacity-100",
              "group-focus-within/banner-stack:pointer-events-auto group-focus-within/banner-stack:translate-y-0 group-focus-within/banner-stack:opacity-100",
              isStackExpanded ? "pointer-events-auto translate-y-0 opacity-100" : null,
            )}
          >
            {stackedItems.map((item) => (
              <div
                key={item.id}
                className={cn(exitingItemId === item.id ? "pointer-events-none" : null)}
                style={{
                  ...activeExitTransitionStyle,
                  ...(exitingItemId === item.id ? stackedExitStyle : restingStyle),
                }}
              >
                <ComposerBannerStackAlert
                  item={item}
                  exiting={exitingItemId === item.id}
                  onDismissRequest={() => requestDismiss(item)}
                />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ComposerBannerStackAlert({
  item,
  exiting,
  onDismissRequest,
}: {
  readonly item: ComposerBannerStackItem;
  readonly exiting: boolean;
  readonly onDismissRequest: () => void;
}) {
  const dismissOnly = item.onDismiss && !item.actions;

  // The alert tint is translucent; back it with the page surface so transcript
  // text scrolling under the floating composer never shows through.
  return (
    <div className="rounded-xl bg-background">
      <Alert variant={item.variant}>
        {item.icon}
        <AlertTitle>{item.title}</AlertTitle>
        {item.description ? <AlertDescription>{item.description}</AlertDescription> : null}
        {item.actions || item.onDismiss ? (
          <AlertAction
            className={
              dismissOnly
                ? "phone:col-start-3 phone:row-start-1 phone:mt-0 phone:self-start"
                : undefined
            }
          >
            {item.actions}
            {item.onDismiss ? (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={item.dismissLabel ?? "Dismiss warning"}
                disabled={exiting}
                onClick={onDismissRequest}
              >
                <XIcon className="size-3.5" />
              </Button>
            ) : null}
          </AlertAction>
        ) : null}
      </Alert>
    </div>
  );
}
