import type React from "react";

import { APP_DISPLAY_NAME } from "../../branding";

/**
 * The shared pairing-surface shell. `#root` is `overflow-y: hidden`, so the
 * previous `min-h-screen items-center justify-center overflow-hidden` card
 * clipped anything taller than the viewport with no way to reach it — the same
 * defect the hosted entry surfaces carried, and it bites hardest at 320x568
 * with a pairing error rendered. The surface now owns its own vertical scroll,
 * centres the card with `my-auto` on a `min-h-full` track, and lets the phone
 * tier fill the viewport instead of floating a card. The decorative wash moves
 * to `fixed` so it no longer depends on a clipping ancestor.
 *
 * It lives apart from the pairing form (`./PairingRouteSurface`) so the
 * `/pair` route's pending surface ships with boot while the form loads as the
 * route's body.
 */
export function PairingSurface({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative h-dvh overflow-x-hidden overflow-y-auto overscroll-contain bg-background text-foreground">
      <div className="pointer-events-none fixed inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-emerald-500)_14%,transparent),transparent)]" />
        <div className="absolute inset-y-0 left-0 w-72 bg-[radial-gradient(28rem_18rem_at_left,color-mix(in_srgb,var(--color-sky-500)_10%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>
      <div className="relative flex min-h-full flex-col px-4 py-10 sm:px-6 phone:px-[max(1rem,env(safe-area-inset-left),env(safe-area-inset-right))] phone:pt-[max(2.5rem,calc(env(safe-area-inset-top)+1rem))] phone:pb-[max(2.5rem,calc(env(safe-area-inset-bottom)+1rem))]">
        <section className="relative my-auto w-full max-w-xl self-center rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8 phone:my-0 phone:flex phone:max-w-none phone:flex-1 phone:flex-col phone:rounded-none phone:border-0 phone:bg-transparent phone:p-0 phone:shadow-none phone:backdrop-blur-none">
          {children}
        </section>
      </div>
    </div>
  );
}

export function PairingPendingSurface() {
  return (
    <PairingSurface>
      <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
        {APP_DISPLAY_NAME}
      </p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
        Pairing with this environment
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        Validating the pairing link and preparing your session.
      </p>
    </PairingSurface>
  );
}
