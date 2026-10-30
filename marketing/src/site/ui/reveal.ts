/**
 * Shared scroll reveals, called from inside a section's useGsap() setup so the
 * SplitText instances and triggers are reverted with that section.
 */
import { gsap, SplitText } from "@/lib/motion";

/**
 * Masked line (or char) rise. Re-splits itself on resize and font load.
 *
 * Screen readers: headings keep SplitText's aria-label (read on headings).
 * Other elements (paragraphs, names in spans) are hidden while split and get a
 * visually hidden copy of their text, because an aria-label on a generic
 * element is not voiced by NVDA/JAWS and the text would simply vanish.
 */
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
  const heading = el.matches("h1, h2, h3, h4, h5, h6");
  const text = (el.textContent ?? "").trim();
  let srCopy: HTMLElement | null = null;
  return SplitText.create(el, {
    type: by === "lines" ? "lines" : `lines,${by}`,
    mask: "lines",
    linesClass: "split-line",
    autoSplit: true,
    aria: heading ? "auto" : "hidden",
    onSplit(self) {
      if (!heading && !srCopy) {
        srCopy = document.createElement("span");
        srCopy.className = "sr-only";
        srCopy.textContent = text;
        el.after(srCopy);
      }
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
    onRevert() {
      srCopy?.remove();
      srCopy = null;
    },
  });
}

/**
 * Simple rise-and-fade for blocks (cards, rows, media). Opacity only, never
 * visibility: revealed blocks hold links and buttons that must stay in the tab
 * order before they scroll into view. Keyboard focus landing inside one
 * finishes its reveal at once, so a focused control is never invisible.
 */
export function revealUp(
  targets: gsap.TweenTarget,
  trigger: Element,
  opts: { stagger?: number; y?: number; start?: string } = {},
) {
  const tween = gsap.from(targets, {
    opacity: 0,
    y: opts.y ?? 36,
    duration: 1,
    stagger: opts.stagger ?? 0.08,
    ease: "ryco",
    scrollTrigger: { trigger, start: opts.start ?? "top 85%", once: true },
    onComplete: () => trigger.removeEventListener("focusin", finish),
  });
  function finish() {
    tween.scrollTrigger?.kill();
    tween.progress(1);
  }
  trigger.addEventListener("focusin", finish, { once: true });
  return tween;
}
