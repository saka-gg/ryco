/**
 * The motion kernel: one GSAP registration, the house eases, a scoped-context
 * hook, a reduced-motion hook, and Lenis smooth scroll wired into the GSAP
 * ticker so ScrollTrigger and the smoothed scroll never disagree on a frame.
 *
 * Every hook here no-ops under prefers-reduced-motion; components render their
 * settled state up front and only *animate from* it, so nothing is ever hidden
 * when motion is off.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin";
import { CustomEase } from "gsap/CustomEase";
import { ScrambleTextPlugin } from "gsap/ScrambleTextPlugin";
import Lenis from "lenis";

gsap.registerPlugin(ScrollTrigger, SplitText, DrawSVGPlugin, CustomEase, ScrambleTextPlugin);

/* The Ryco app's own house curve (--app-motion-ease), so the site and the
   product move with the same hand. */
CustomEase.create("ryco", "0.16, 1, 0.3, 1");
CustomEase.create("ryco.inOut", "0.76, 0, 0.24, 1");
gsap.defaults({ ease: "ryco", duration: 0.9 });

export const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Live reduced-motion preference (re-renders if the OS setting flips). */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Run GSAP setup inside a context scoped to the returned ref. Everything the
 * callback creates (tweens, ScrollTriggers, SplitTexts) is reverted on unmount.
 * Skipped under reduced motion, and torn down or rebuilt live if the OS
 * preference flips mid-visit, so the layout and the motion always agree.
 */
export function useGsap<T extends HTMLElement = HTMLDivElement>(
  setup: (scope: T) => void | (() => void),
  deps: ReadonlyArray<unknown> = [],
) {
  const scope = useRef<T>(null);
  const reduced = useReducedMotion();
  useIsoLayoutEffect(() => {
    const el = scope.current;
    if (!el || reduced) return;
    let cleanup: void | (() => void);
    const ctx = gsap.context(() => {
      cleanup = setup(el);
    }, el);
    return () => {
      cleanup?.();
      ctx.revert();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, reduced]);
  return scope;
}

/* ------------------------------ smooth scroll ------------------------------ */

let lenis: Lenis | null = null;
export const getLenis = () => lenis;

/** Mount once at the page root. Native scroll under reduced motion (live). */
export function useSmoothScroll() {
  const reduced = useReducedMotion();
  useEffect(() => {
    if (reduced) return;
    const instance = new Lenis({
      lerp: 0.1,
      wheelMultiplier: 1,
      anchors: { offset: -72 },
    });
    lenis = instance;
    instance.on("scroll", ScrollTrigger.update);
    const tick = (time: number) => instance.raf(time * 1000);
    /* first in the tick: scroll before any tween dirties layout, so Lenis's
       scrollTo never forces a synchronous layout flush */
    gsap.ticker.add(tick, false, true);
    gsap.ticker.lagSmoothing(0);
    return () => {
      gsap.ticker.remove(tick);
      instance.destroy();
      lenis = null;
    };
  }, [reduced]);
}

/**
 * CSS loops (spinners, carets, relay dashes) keep invalidating layers every
 * frame even when nobody can see them. Every `[data-loops]` element gets
 * `data-idle` while it is off screen, which pauses all animations inside it
 * (see index.css). Starts idle, so nothing ticks until it scrolls into view.
 */
export function usePauseOffscreenLoops() {
  useEffect(() => {
    const els = document.querySelectorAll<HTMLElement>("[data-loops]");
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) e.target.toggleAttribute("data-idle", !e.isIntersecting);
      },
      { rootMargin: "120px 0px" },
    );
    els.forEach((el) => {
      el.setAttribute("data-idle", "");
      io.observe(el);
    });
    return () => io.disconnect();
  }, []);
}

/**
 * Re-measure every ScrollTrigger once the web fonts have settled. Trigger
 * positions computed with fallback metrics drift by tens of pixels once
 * Archivo and DM Sans arrive (headings re-wrap), so reveals, the nav spy and
 * the footer wordmark would otherwise fire at the wrong scroll offsets.
 */
export function useRefreshAfterFonts() {
  useEffect(() => {
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) ScrollTrigger.refresh();
    });
    return () => {
      live = false;
    };
  }, []);
}

/**
 * Scroll to an in-page anchor through Lenis when it's running, and move
 * keyboard focus there too: these are skip links, so the next Tab must
 * continue inside the target section rather than back in the nav.
 */
export function scrollToId(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  if (lenis) lenis.scrollTo(el, { offset: -72 });
  else el.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth" });
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
}

export { gsap, ScrollTrigger, SplitText };
