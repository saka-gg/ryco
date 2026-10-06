import { useCallback, useEffect, useRef, useState } from "react";

import type { ProjectSection } from "../projectsSearch";

/** How far below the scroll container's top a section's heading must pass to be current. */
const SPY_OFFSET_PX = 96;

/**
 * The section the reader is in: the last one whose top has passed just below
 * the top of the scroll container, or the last section once the page is
 * scrolled to its end (short sections at the bottom can never reach the top).
 *
 * A navigation click pins its section — a section near the end may never
 * become "current" by position — until the reader scrolls themselves.
 */
export function useProjectSectionSpy(
  scrollElement: HTMLElement | null,
  sections: readonly ProjectSection[],
): { readonly active: ProjectSection | null; readonly pin: (section: ProjectSection) => void } {
  const [active, setActive] = useState<ProjectSection | null>(sections[0] ?? null);
  const pinnedRef = useRef<ProjectSection | null>(null);

  useEffect(() => {
    if (!scrollElement) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (pinnedRef.current !== null) {
        setActive(pinnedRef.current);
        return;
      }
      const scrollable = scrollElement.scrollHeight > scrollElement.clientHeight + 1;
      const atEnd =
        scrollable &&
        scrollElement.scrollTop + scrollElement.clientHeight >= scrollElement.scrollHeight - 2;
      if (atEnd) {
        setActive(sections.at(-1) ?? null);
        return;
      }
      const threshold = scrollElement.getBoundingClientRect().top + SPY_OFFSET_PX;
      let current = sections[0] ?? null;
      for (const section of sections) {
        const element = scrollElement.querySelector<HTMLElement>(
          `[data-project-section="${section}"]`,
        );
        if (element && element.getBoundingClientRect().top <= threshold) current = section;
      }
      setActive(current);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    // The reader scrolling on their own takes over from a navigation click.
    const release = () => {
      if (pinnedRef.current === null) return;
      pinnedRef.current = null;
      schedule();
    };
    measure();
    scrollElement.addEventListener("scroll", schedule, { passive: true });
    scrollElement.addEventListener("wheel", release, { passive: true });
    scrollElement.addEventListener("touchstart", release, { passive: true });
    scrollElement.addEventListener("pointerdown", release);
    scrollElement.addEventListener("keydown", release);
    const observer = new ResizeObserver(schedule);
    observer.observe(scrollElement);
    if (scrollElement.firstElementChild) observer.observe(scrollElement.firstElementChild);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      scrollElement.removeEventListener("scroll", schedule);
      scrollElement.removeEventListener("wheel", release);
      scrollElement.removeEventListener("touchstart", release);
      scrollElement.removeEventListener("pointerdown", release);
      scrollElement.removeEventListener("keydown", release);
    };
  }, [scrollElement, sections]);

  const pin = useCallback((section: ProjectSection) => {
    pinnedRef.current = section;
    setActive(section);
  }, []);
  return { active, pin };
}
