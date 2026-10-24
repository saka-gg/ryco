import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";

export type InboxOrderHoldRuntime = typeof import("./inboxOrderHoldRuntime");
// Outside the hook: the React Compiler cannot lower `import()`.
const loadInboxOrderHoldRuntime = (): Promise<InboxOrderHoldRuntime> =>
  import("./inboxOrderHoldRuntime");

export interface InboxOrderHold {
  /**
   * While the inbox's rows must keep their places, the logic that keeps them;
   * otherwise null.
   */
  readonly hold: InboxOrderHoldRuntime | null;
  /**
   * For the inbox's root element. Its hover card, hints and menus render in
   * portals outside that element, but React routes their pointer events
   * through it, so they count as the inbox.
   */
  readonly onPointerOverCapture: (event: ReactPointerEvent) => void;
}

/**
 * Whether the user is aiming at the inbox `element` (see `trackInboxAim`).
 * The tracking loads once `element` mounts, outside the shell's bundle; until
 * it arrives, nothing holds.
 */
export function useInboxOrderHold(element: HTMLElement | null): InboxOrderHold {
  const [holding, setHolding] = useState(false);
  const [runtime, setRuntime] = useState<InboxOrderHoldRuntime | null>(null);
  // A pointerover always precedes the pointermove and pointerdown on a new
  // target, so the last one React routed through the inbox root identifies a
  // popup target that `element.contains` cannot see.
  const claimedTarget = useRef<EventTarget | null>(null);
  const onPointerOverCapture = (event: ReactPointerEvent) => {
    claimedTarget.current = event.target;
  };

  useEffect(() => {
    if (!element) return;
    if (runtime === null) {
      void loadInboxOrderHoldRuntime().then(setRuntime, () => undefined);
      return;
    }
    const stopTracking = runtime.trackInboxAim(element, claimedTarget, setHolding);
    return () => {
      stopTracking();
      setHolding(false);
    };
  }, [element, runtime]);

  return { hold: element !== null && holding ? runtime : null, onPointerOverCapture };
}
