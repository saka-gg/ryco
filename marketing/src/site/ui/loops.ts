/**
 * Helpers for the looping micro-demos (Toolkit, Latest). A demo's loop only
 * plays while its cell is in the viewport, and text swaps write straight into
 * the DOM so a loop never re-renders React.
 */
import { ScrollTrigger } from "@/lib/motion";

/** Play `tl` only while `cell` is in the viewport. */
export function whileVisible(cell: Element, tl: { play: () => unknown; pause: () => unknown }) {
  return ScrollTrigger.create({
    trigger: cell,
    start: "top bottom",
    end: "bottom top",
    onToggle: (self) => (self.isActive ? tl.play() : tl.pause()),
  });
}

export const setText = (el: Element, text: string) => {
  el.textContent = text;
};
