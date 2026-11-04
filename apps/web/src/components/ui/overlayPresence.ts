// Whether a modal dialog or a picker popup is open, for toasts that wait
// rather than cover one (`ThreadToastData.deferWhileOverlayOpen`). The dialog,
// alert-dialog, popover and combobox primitives render `<OpenOverlayMarker />`
// inside their portal, which mounts only while the overlay is open (or folding
// away), so the count needs no open-state wiring. It sits in boot with the
// toasts; keep it this small.
import { useEffect } from "react";
import { create } from "zustand";

const useOpenOverlayCount = create(() => 0);

/** Counts the overlay whose portal renders it as open while it is mounted. */
export function OpenOverlayMarker(): null {
  "use no memo";
  useEffect(() => {
    useOpenOverlayCount.setState((count) => count + 1);
    return () => useOpenOverlayCount.setState((count) => count - 1);
  }, []);
  return null;
}

/** True while any marked overlay is open. */
export const useAnyOverlayOpen = (): boolean => useOpenOverlayCount((count) => count > 0);
