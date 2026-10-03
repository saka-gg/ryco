/**
 * Shared scroll reveals, called from inside a section's useGsap() setup so the
 * SplitText instances and triggers are reverted with that section.
 */
import { gsap, SplitText } from "@/lib/motion";

/** Masked line (or char) rise. Re-splits itself on resize and font load. */
export function revealText(
  el: Element,
  {
    by = "lines",
    stagger = by === "chars" ? 0.018 : 0.09,
    start = "top 85%",
    delay = 0,
    widen = false,
  }: {
    by?: "lines" | "words" | "chars";
    stagger?: number;
    start?: string;
    delay?: number;
    /** Also open Archivo's width axis from condensed as each piece rises. */
    widen?: boolean;
  } = {},
) {
  return SplitText.create(el, {
    type: by === "lines" ? "lines" : `lines,${by}`,
    mask: "lines",
    linesClass: "split-line",
    autoSplit: true,
    onSplit(self) {
      const targets = by === "chars" ? self.chars : by === "words" ? self.words : self.lines;
      return gsap.from(targets, {
        yPercent: 115,
        duration: 1.15,
        stagger,
        delay,
        ease: "ryco",
        /* cleared after, so hover effects on the parent can drive the axis */
        ...(widen
          ? { fontVariationSettings: "'wdth' 62", clearProps: "fontVariationSettings" }
          : {}),
        scrollTrigger: { trigger: el, start, once: true },
      });
    },
  });
}

/** Simple rise-and-fade for blocks (cards, rows, media). */
export function revealUp(
  targets: gsap.TweenTarget,
  trigger: Element,
  opts: { stagger?: number; y?: number; start?: string } = {},
) {
  return gsap.from(targets, {
    autoAlpha: 0,
    y: opts.y ?? 36,
    duration: 1,
    stagger: opts.stagger ?? 0.08,
    ease: "ryco",
    scrollTrigger: { trigger, start: opts.start ?? "top 85%", once: true },
  });
}
