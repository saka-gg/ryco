import { useEffect, useState } from "react";

type ViewportIntersectionRef = (node: HTMLElement | null) => void;

function isNearViewport(node: HTMLElement, rootMargin: string): boolean {
  if (node.getClientRects().length === 0) return false;
  const margin = Number.parseFloat(rootMargin) || 0;
  const rect = node.getBoundingClientRect();
  return (
    rect.bottom >= -margin &&
    rect.top <= window.innerHeight + margin &&
    rect.right >= 0 &&
    rect.left <= window.innerWidth
  );
}

export function useHasIntersectedViewport(
  rootMargin = "160px 0px",
): [ViewportIntersectionRef, boolean] {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [hasIntersected, setHasIntersected] = useState(false);

  useEffect(() => {
    if (hasIntersected || node === null) {
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setHasIntersected(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setHasIntersected(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasIntersected, node, rootMargin]);

  return [setNode, hasIntersected];
}

export function useIsIntersectingViewport(
  rootMargin = "160px 0px",
): [ViewportIntersectionRef, boolean] {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [isIntersecting, setIsIntersecting] = useState(false);

  useEffect(() => {
    if (node === null) {
      setIsIntersecting(false);
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      const updateIntersection = () => {
        setIsIntersecting(isNearViewport(node, rootMargin));
      };
      updateIntersection();
      window.addEventListener("resize", updateIntersection);
      window.addEventListener("scroll", updateIntersection, true);
      return () => {
        window.removeEventListener("resize", updateIntersection);
        window.removeEventListener("scroll", updateIntersection, true);
      };
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.find((candidate) => candidate.target === node);
        if (entry) {
          setIsIntersecting(entry.isIntersecting);
        }
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, rootMargin]);

  return [setNode, isIntersecting];
}
