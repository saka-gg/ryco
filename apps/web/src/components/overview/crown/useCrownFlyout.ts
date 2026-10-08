import { useCallback, useEffect, useRef, useState } from "react";

import { CROWN_FLYOUT_CLOSE_DELAY_MS } from "./crownLayout";
import type { CrownRailKey } from "./crownSections";

interface FlyoutTarget {
  readonly key: CrownRailKey;
  readonly el: HTMLElement;
}

export interface CrownFlyout {
  readonly openKey: CrownRailKey | null;
  /** The hovered rail button the flyout grows out of. */
  readonly anchorEl: HTMLElement | null;
  readonly onRailPointerOver: (key: CrownRailKey, el: HTMLElement) => void;
  readonly onRailPointerLeave: () => void;
  readonly onFlyoutPointerEnter: () => void;
  readonly onFlyoutPointerLeave: () => void;
  readonly close: () => void;
}

/**
 * Hover intent for the rail's preview flyout (prototype `Flyout`): hovering an
 * icon opens or retargets the single flyout, leaving the rail or the flyout
 * closes it after {@link CROWN_FLYOUT_CLOSE_DELAY_MS}, and re-entering either
 * cancels the close. Disabling (e.g. the card opening) closes it at once.
 */
export function useCrownFlyout(input: { readonly enabled: boolean }): CrownFlyout {
  const { enabled } = input;
  const [target, setTarget] = useState<FlyoutTarget | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current === null) return;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const close = useCallback(() => {
    cancelClose();
    setTarget(null);
  }, [cancelClose]);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setTarget(null);
    }, CROWN_FLYOUT_CLOSE_DELAY_MS);
  }, [cancelClose]);

  // Disabling closes at once (adjusted during render); a pending close timer only re-closes.
  if (!enabled && target !== null) setTarget(null);
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => cancelClose, [cancelClose]);

  const onRailPointerOver = useCallback(
    (key: CrownRailKey, el: HTMLElement) => {
      cancelClose();
      if (!enabledRef.current) return;
      // pointerover bubbles from every child; keep the same object to skip re-renders.
      setTarget((current) => (current?.key === key && current.el === el ? current : { key, el }));
    },
    [cancelClose],
  );

  return {
    openKey: target?.key ?? null,
    anchorEl: target?.el ?? null,
    onRailPointerOver,
    onRailPointerLeave: scheduleClose,
    onFlyoutPointerEnter: cancelClose,
    onFlyoutPointerLeave: scheduleClose,
    close,
  };
}
