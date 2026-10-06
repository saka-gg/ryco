/**
 * The editor's entrance (the lab's `openEditor` motion). From the selected
 * schedule's detail the title field sits where the heading was, so nothing
 * travels: only the header's controls fade in and the rest rises in under
 * it. A new draft grows out of the control that asked for it — a plate (the
 * surface, never its text) flies from it to the header while the content
 * rises in behind. Reduced motion keeps a short crossfade.
 */
import { DIALOG_MORPH_PROFILE } from "../../../ui/surfaceMorph";
import { DIALOG_EASE, dialogMotionOn, flyPlate, paintOf } from "../paneMotion";

export function animateEditorIn(input: {
  /** `.ad-ed-in`: the editor's content column. */
  readonly content: HTMLElement;
  /** The header (title field + Repeats | Once). */
  readonly head: HTMLElement;
  readonly footer: HTMLElement;
  /** The control a new draft grows out of, or null. */
  readonly origin: HTMLElement | null;
  /** Opened from the schedule's own detail: the header stays where it is. */
  readonly fromDetail: boolean;
}): void {
  const { content, head, footer, origin, fromDetail } = input;
  if (typeof HTMLElement.prototype.animate !== "function") return;
  // Opened by a request (no control, not from the detail): it just appears.
  if (!fromDetail && !origin) return;
  const pane = content.closest<HTMLElement>(".ad-pane");
  if (!dialogMotionOn()) {
    pane?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
    return;
  }
  const from = !fromDetail && origin?.isConnected ? origin.getBoundingClientRect() : null;
  const flying = from !== null && from.width > 0;
  const grow = DIALOG_MORPH_PROFILE.grow;
  const duration = Math.min(grow.durationMs, 520);
  const reveal = flying ? duration * 0.36 : 40;
  Array.from(content.children).forEach((child, index) => {
    if (fromDetail && child === head) {
      head.querySelector(".ad-dh-x")?.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: 160,
        fill: "backwards",
      });
      return;
    }
    child.animate(
      [
        { opacity: 0, translate: "0 6px" },
        { opacity: 1, translate: "0 0" },
      ],
      {
        duration: 260,
        delay: reveal + Math.min(index, 6) * 36,
        easing: DIALOG_EASE,
        fill: "backwards",
      },
    );
  });
  footer.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: 200,
    delay: reveal + 120,
    fill: "backwards",
  });
  if (flying && origin) {
    void flyPlate(content.closest(".ad-dialog") ?? document.body, {
      from,
      to: head.getBoundingClientRect(),
      fromPaint: paintOf(origin),
      toPaint: {
        bg: "rgba(127, 127, 127, 0.06)",
        shadow: "inset 0 0 0 1px transparent",
        radius: 8,
      },
      duration,
      easing: grow.easing,
      fadeFrom: 0.55,
    });
  }
}

/** A sentence part that just appeared fades in; the sentence settles once. */
export function animateSentenceChange(sentence: HTMLElement, appeared: readonly Element[]): void {
  if (typeof HTMLElement.prototype.animate !== "function") return;
  const motion = dialogMotionOn();
  for (const part of appeared)
    part.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: motion ? 200 : 100,
      easing: "ease-out",
    });
  if (motion)
    sentence.animate([{ opacity: 0.6 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
}
