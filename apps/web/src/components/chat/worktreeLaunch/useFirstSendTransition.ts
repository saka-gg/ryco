import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { isReducedMotionEffective } from "~/themes/appearancePreferences";

// The approved prototype's first-send motion.
const COMPOSER_GLIDE_MS = 420;
const GLIDE_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
const HERO_FADE_MS = 200;
const HERO_LIFT_MS = 300;
const HERO_LIFT_PX = 14;
const HERO_BLUR_PX = 3;
/** How long the sent message keeps its rise-in class (the rise itself is 320ms). */
const ENTERING_MESSAGE_MS = 600;
/** A capture the send never followed up on (it failed early) goes stale. */
const CAPTURE_TTL_MS = 2_000;

interface FirstSendCapture {
  readonly heroGhost: HTMLElement | null;
  readonly heroTop: number;
  readonly heroLeft: number;
  readonly heroWidth: number;
  readonly composerTop: number;
  readonly atMs: number;
}

/**
 * The first send from the new-thread surface: the hero sentence lifts away
 * while the composer glides from the middle of the pane to its dock, and the
 * message rises into the timeline. The hero leaves the tree in the same
 * commit the message enters, so its exit plays on a static snapshot taken
 * just before (`captureFirstSendLayout`, called while the hero still shows).
 */
export function useFirstSendTransition(input: {
  readonly showNewThreadSurface: boolean;
  readonly chatColumnRef: RefObject<HTMLElement | null>;
  readonly heroRef: RefObject<HTMLElement | null>;
  readonly composerBoxRef: RefObject<HTMLElement | null>;
  readonly composerBarRef: RefObject<HTMLElement | null>;
  readonly latestOptimisticMessageId: string | null;
}): { readonly captureFirstSendLayout: () => void; readonly enteringMessageId: string | null } {
  const captureRef = useRef<FirstSendCapture | null>(null);
  const showingRef = useRef(input.showNewThreadSurface);
  useLayoutEffect(() => {
    showingRef.current = input.showNewThreadSurface;
  }, [input.showNewThreadSurface]);
  const [enteringMessageId, setEnteringMessageId] = useState<string | null>(null);
  const { chatColumnRef, heroRef, composerBoxRef, composerBarRef } = input;

  const captureFirstSendLayout = useCallback(() => {
    captureRef.current = null;
    if (!showingRef.current || isReducedMotionEffective()) return;
    const column = chatColumnRef.current;
    const composerBox = composerBoxRef.current;
    if (!column || !composerBox) return;
    const columnRect = column.getBoundingClientRect();
    const hero = heroRef.current;
    const heroRect = hero?.getBoundingClientRect() ?? null;
    let heroGhost: HTMLElement | null = null;
    if (hero) {
      heroGhost = hero.cloneNode(true) as HTMLElement;
      // A picture of the hero, not a second one: no ids, no focus, no clicks,
      // and none of the wrapper's own entrance animation.
      heroGhost.removeAttribute("class");
      for (const element of heroGhost.querySelectorAll("[id]")) element.removeAttribute("id");
      heroGhost.setAttribute("aria-hidden", "true");
      heroGhost.inert = true;
    }
    captureRef.current = {
      heroGhost,
      heroTop: (heroRect?.top ?? 0) - columnRect.top,
      heroLeft: (heroRect?.left ?? 0) - columnRect.left,
      heroWidth: heroRect?.width ?? 0,
      composerTop: composerBox.getBoundingClientRect().top,
      atMs: Date.now(),
    };
  }, [chatColumnRef, composerBoxRef, heroRef]);

  const previousShowingRef = useRef(input.showNewThreadSurface);
  useLayoutEffect(() => {
    const wasShowing = previousShowingRef.current;
    previousShowingRef.current = input.showNewThreadSurface;
    if (!wasShowing || input.showNewThreadSurface) return;
    const capture = captureRef.current;
    captureRef.current = null;
    if (!capture || Date.now() - capture.atMs > CAPTURE_TTL_MS || isReducedMotionEffective()) {
      return;
    }

    const composerBox = composerBoxRef.current;
    const composerBar = composerBarRef.current;
    if (composerBox && composerBar) {
      const dy = capture.composerTop - composerBox.getBoundingClientRect().top;
      if (Math.abs(dy) > 0.5) {
        composerBar.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], {
          duration: COMPOSER_GLIDE_MS,
          easing: GLIDE_EASING,
        });
      }
    }

    const column = chatColumnRef.current;
    const ghost = capture.heroGhost;
    if (column && ghost) {
      Object.assign(ghost.style, {
        position: "absolute",
        top: `${capture.heroTop}px`,
        left: `${capture.heroLeft}px`,
        width: `${capture.heroWidth}px`,
        pointerEvents: "none",
        zIndex: "10",
      });
      column.append(ghost);
      ghost.animate(
        [
          { opacity: 1, filter: "blur(0)" },
          { opacity: 0, filter: `blur(${HERO_BLUR_PX}px)` },
        ],
        { duration: HERO_FADE_MS, easing: "ease", fill: "forwards" },
      );
      ghost.animate([{ transform: "none" }, { transform: `translateY(-${HERO_LIFT_PX}px)` }], {
        duration: HERO_LIFT_MS,
        easing: GLIDE_EASING,
        fill: "forwards",
      });
      window.setTimeout(() => ghost.remove(), HERO_LIFT_MS);
    }

    setEnteringMessageId(input.latestOptimisticMessageId);
  }, [
    chatColumnRef,
    composerBarRef,
    composerBoxRef,
    input.latestOptimisticMessageId,
    input.showNewThreadSurface,
  ]);

  useEffect(() => {
    if (enteringMessageId === null) return;
    const timer = window.setTimeout(() => setEnteringMessageId(null), ENTERING_MESSAGE_MS);
    return () => window.clearTimeout(timer);
  }, [enteringMessageId]);

  return { captureFirstSendLayout, enteringMessageId };
}
