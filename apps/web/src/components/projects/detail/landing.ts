/**
 * Mark an element as where the page landed: `className` runs its CSS animation
 * once and leaves when it ends. Landing on the same element twice replays it.
 * The class's keyframes must share its name.
 */
export function ringOnce(element: HTMLElement, className: string): void {
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
  const onEnd = (event: AnimationEvent) => {
    if (event.animationName !== className) return;
    element.classList.remove(className);
    element.removeEventListener("animationend", onEnd);
  };
  element.addEventListener("animationend", onEnd);
}
