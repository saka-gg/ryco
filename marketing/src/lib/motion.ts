/**
 * Shared motion helpers. Versions may use these or roll their own — they exist
 * so common patterns (scroll reveal, parallax, GSAP context cleanup) are not
 * reimplemented five times. All helpers no-op under prefers-reduced-motion.
 */
import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

export const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Run GSAP code inside a scoped context bound to a container ref. The callback
 * receives the gsap instance; everything is reverted automatically on unmount.
 */
export function useGsapContext(
  setup: (ctx: { gsap: typeof gsap; ScrollTrigger: typeof ScrollTrigger }) => void,
  deps: ReadonlyArray<unknown> = [],
) {
  const scope = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const ctx = gsap.context(() => setup({ gsap, ScrollTrigger }), scope);
    return () => ctx.revert();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller passes the dependency list, as with useEffect itself
  }, deps);
  return scope;
}

/**
 * Pointer-driven 3D tilt. Every `[data-tilt]` element inside the scope leans
 * toward the cursor on a perspective plane and eases back on leave; an optional
 * `[data-glare]` child gets a soft highlight that tracks the pointer. Per-element
 * strength via `data-tilt-max` (degrees). No-ops for coarse pointers and reduced
 * motion, so touch + accessibility users just get the flat card.
 */
export function useTilt(scopeRef: React.RefObject<HTMLElement | null>, selector = "[data-tilt]") {
  useEffect(() => {
    if (prefersReducedMotion()) return;
    if (window.matchMedia("(pointer: coarse)").matches) return;
    const root = scopeRef.current;
    if (!root) return;

    const cleanups: Array<() => void> = [];
    root.querySelectorAll<HTMLElement>(selector).forEach((el) => {
      const max = Number(el.dataset.tiltMax ?? 8);
      const glare = el.querySelector<HTMLElement>("[data-glare]");
      gsap.set(el, { transformPerspective: 900, transformStyle: "preserve-3d" });
      const rotX = gsap.quickTo(el, "rotationX", { duration: 0.6, ease: "power3" });
      const rotY = gsap.quickTo(el, "rotationY", { duration: 0.6, ease: "power3" });

      const move = (e: PointerEvent) => {
        const r = el.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - 0.5; // -0.5 … 0.5
        const py = (e.clientY - r.top) / r.height - 0.5;
        rotY(px * max * 2);
        rotX(-py * max * 2);
        if (glare) {
          glare.style.setProperty("--gx", `${(px + 0.5) * 100}%`);
          glare.style.setProperty("--gy", `${(py + 0.5) * 100}%`);
        }
      };
      const enter = () => {
        gsap.to(el, { scale: 1.015, duration: 0.5, ease: "power3" });
        if (glare) gsap.to(glare, { opacity: 1, duration: 0.4 });
      };
      const leave = () => {
        rotX(0);
        rotY(0);
        gsap.to(el, { scale: 1, duration: 0.6, ease: "power3" });
        if (glare) gsap.to(glare, { opacity: 0, duration: 0.5 });
      };

      el.addEventListener("pointerenter", enter);
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerleave", leave);
      cleanups.push(() => {
        el.removeEventListener("pointerenter", enter);
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerleave", leave);
        gsap.set(el, { clearProps: "transform" });
      });
    });
    return () => cleanups.forEach((c) => c());
  }, [scopeRef, selector]);
}

/**
 * Reveal children matching `selector` on scroll with a staggered rise.
 */
export function useScrollReveal(
  selector = "[data-reveal]",
  opts: { y?: number; stagger?: number; duration?: number } = {},
) {
  return useGsapContext(({ gsap }) => {
    const { y = 28, stagger = 0.08, duration = 0.8 } = opts;
    const els = gsap.utils.toArray<HTMLElement>(selector);
    els.forEach((el) => {
      gsap.from(el, {
        opacity: 0,
        y,
        duration,
        ease: "power3.out",
        stagger,
        scrollTrigger: { trigger: el, start: "top 85%", once: true },
      });
    });
  });
}

export { gsap, ScrollTrigger };
