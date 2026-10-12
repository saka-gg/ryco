import { useCallback, useEffect, useRef, useState } from "react";

/** Pointer or focus must rest this long before the row reads full status. */
export const INBOX_PREVIEW_INTENT_DWELL_MS = 120;
/** How long full status stays subscribed after the pointer or focus left. */
export const INBOX_PREVIEW_INTENT_LINGER_MS = 20_000;

export interface InboxRowPreviewIntent {
  readonly active: boolean;
  readonly start: () => void;
  readonly end: () => void;
}

/**
 * Whether a row's hover card may be showing, for data only the card needs
 * (working-tree numbers from full git status). It turns on after a short
 * dwell, so a pointer sweeping across the list subscribes nothing, and stays
 * on for a while after the pointer leaves: the card closes with a delay and
 * the pointer usually moves into it.
 */
export function useInboxRowPreviewIntent(): InboxRowPreviewIntent {
  const [active, setActive] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => clearTimer, [clearTimer]);

  const start = useCallback(() => {
    clearTimer();
    if (active) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setActive(true);
    }, INBOX_PREVIEW_INTENT_DWELL_MS);
  }, [active, clearTimer]);
  const end = useCallback(() => {
    clearTimer();
    if (!active) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setActive(false);
    }, INBOX_PREVIEW_INTENT_LINGER_MS);
  }, [active, clearTimer]);

  return { active, start, end };
}
