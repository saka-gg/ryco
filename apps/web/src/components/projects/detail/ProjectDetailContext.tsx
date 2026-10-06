import { createContext, useCallback, useContext, useEffect, useRef } from "react";

import type { ProjectSection } from "../projectsSearch";

/**
 * Detail-level coordination: the hero reports whether it is on screen (the
 * bar title appears only once its name has scrolled away), and anything in
 * the detail — the section navigation, the bar's menu — can bring a section
 * into view.
 */
export interface ProjectDetailContextValue {
  readonly setHeroInView: (inView: boolean) => void;
  /** Scroll a section into view, ring it, and record it in the URL. */
  readonly revealSection: (section: ProjectSection) => void;
}

export const ProjectDetailContext = createContext<ProjectDetailContextValue | null>(null);

export function useProjectDetail(): ProjectDetailContextValue {
  const value = useContext(ProjectDetailContext);
  if (!value) throw new Error("useProjectDetail requires ProjectDetailContext");
  return value;
}

/**
 * Ref for a sentinel at the bottom of the hero. While it is visible inside
 * its scroll container, the bar title stays hidden.
 */
export function useHeroSentinel(): (node: HTMLElement | null) => void {
  // Only the (stable) setter: the context's other members change as the page
  // measures itself, and re-running this would drop the live observer.
  const setHeroInView = useContext(ProjectDetailContext)?.setHeroInView;
  const observerRef = useRef<IntersectionObserver | null>(null);
  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      setHeroInView?.(false);
    },
    [setHeroInView],
  );
  return useCallback(
    (node: HTMLElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!node || !setHeroInView || typeof IntersectionObserver === "undefined") return;
      const observer = new IntersectionObserver(
        (entries) => {
          const entry = entries[0];
          if (entry) setHeroInView(entry.isIntersecting);
        },
        { threshold: 0 },
      );
      observer.observe(node);
      observerRef.current = observer;
      setHeroInView(true);
    },
    [setHeroInView],
  );
}
