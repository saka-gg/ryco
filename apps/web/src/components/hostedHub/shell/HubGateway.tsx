import type { ReactNode, Ref, RefObject } from "react";

import { cn } from "~/lib/utils";
import { HubFooter } from "./HubFooter";
import { HubWordmark } from "./HubWordmark";
import {
  HUB_CENTERED_TRACK_CLASS_NAME,
  HUB_EDGE_PADDING_CLASS_NAME,
  HUB_MEASURE_CLASS_NAME,
  HUB_SCROLL_TRACK_CLASS_NAME,
} from "./hubLayout";

/**
 * The chrome for every signed-out Hub page: sign in, sign up, reset, verify,
 * first-owner setup, invitation redemption.
 *
 * What this replaces, and why. Every one of those ceremonies used to render
 * inside one `max-w-lg` bordered card — the same idiom the desktop app uses for
 * a settings panel — with no masthead, no footer and no page identity, and with
 * each flow's form *appended below* whatever hero copy the sign-in screen had
 * set. Opening password login left "Connect to your Ryco nodes", the relay
 * trust notice and the PWA install buttons stacked above the fields. Here a
 * page owns the column: it states its own title, and nothing else is in it.
 *
 * The three load-bearing behaviours inherited verbatim from the surface this
 * replaces are the own-scroller, the safe-area padding and the `my-auto`
 * centring — see `hubLayout.ts`, where each records the failure it prevents.
 *
 * Deliberately NOT wrapped in a toast host. The signed-out surfaces are outside
 * the toast providers on purpose: an auth error must be inline and adjacent to
 * the control that produced it, and a toast queued against no host never
 * renders at all.
 */
export function HubGateway({
  children,
  title,
  description,
  actions,
  trailing,
  scrollRef,
  titleRef,
  measure = "form",
}: {
  readonly children: ReactNode;
  /**
   * The page's own heading. Rendered as the `h1` and focused on mount by the
   * page, not by this component — the surfaces manage their own focus order.
   */
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /**
   * The page's primary action group. Bottom-anchored on the phone tier by its
   * own `phone:` classes.
   */
  readonly actions?: ReactNode;
  /**
   * Content that must mount in every state and stay last in the DOM — live
   * regions and recovery affordances. Separate from `actions` so a conditional
   * that only applies to the action group cannot swallow it.
   */
  readonly trailing?: ReactNode;
  /** Owner for flow changes that must reset this surface's scroll position. */
  readonly scrollRef?: RefObject<HTMLElement | null>;
  /**
   * Focus target for the page heading. Hub pages move initial focus here so a
   * screen-reader user starts at the page's own title rather than inside its
   * first form control.
   */
  readonly titleRef?: Ref<HTMLHeadingElement>;
  readonly measure?: "form" | "content";
}) {
  return (
    <main ref={scrollRef} className={cn(HUB_SCROLL_TRACK_CLASS_NAME, "hub-ambient")}>
      <div className={cn(HUB_CENTERED_TRACK_CLASS_NAME, HUB_EDGE_PADDING_CLASS_NAME, "py-10")}>
        <div
          className={cn(
            "my-auto w-full self-center phone:my-0 phone:flex phone:max-w-none phone:flex-1 phone:flex-col",
            HUB_MEASURE_CLASS_NAME[measure],
          )}
        >
          <div className="mb-8 flex justify-center phone:mb-6 phone:justify-start">
            <HubWordmark size="lg" />
          </div>

          {/* The panel.
              `app-surface` rather than the flat `bg-card` plate this replaces:
              it is the same material the app's dialogs, popovers and sheets
              already use, so the Hub inherits the shared surface
              language instead of forking it, tracks the user's Material step,
              and is already handled in all three enforcement blocks —
              prefers-reduced-transparency, forced-colors, and the
              no-backdrop-filter fallback. The `before:` hairline and
              `not-dark:bg-clip-padding` are the house bezel idiom that ships
              with it (see ui/dialog.tsx).

              On the phone tier the panel recedes entirely and the page fills
              the viewport, which is what lets the action group bottom-anchor. */}
          <section className="hub-gateway-panel app-surface relative rounded-2xl border p-6 not-dark:bg-clip-padding shadow-lg/5 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] sm:p-8 phone:flex phone:flex-1 phone:flex-col phone:rounded-none phone:border-0 phone:p-0 phone:shadow-none phone:before:hidden dark:before:shadow-[0_-1px_--theme(--color-white/6%)]">
            <h1
              ref={titleRef}
              tabIndex={-1}
              className="font-semibold text-2xl tracking-tight outline-none"
            >
              {title}
            </h1>
            {description === undefined ? null : (
              <p className="mt-2 text-muted-foreground text-sm leading-relaxed">{description}</p>
            )}
            <div className="mt-6 phone:flex phone:flex-1 phone:flex-col">{children}</div>
            {actions}
            {trailing}
          </section>

          <HubFooter />
        </div>
      </div>
    </main>
  );
}
