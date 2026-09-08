import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { isMacPlatform } from "../lib/utils";

export function QuitShortcutFeedback() {
  const [state, setState] = useState<"press-twice" | "hold" | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(
    () =>
      window.desktopBridge?.quitShortcut?.onFeedback((next) => {
        setReady(false);
        setState(next);
      }),
    [],
  );
  useEffect(() => {
    if (state !== "hold") return;
    const timer = setTimeout(() => setReady(true), 1000);
    return () => clearTimeout(timer);
  }, [state]);
  if (!state) return null;
  const shortcut = isMacPlatform(navigator.platform) ? "⌘Q" : "Ctrl+Q";
  return createPortal(
    <div
      role="status"
      className="pointer-events-none fixed bottom-12 left-1/2 z-[100] w-72 -translate-x-1/2 rounded-xl border border-border bg-popover p-4 text-center text-sm text-popover-foreground shadow-xl"
    >
      {state === "press-twice"
        ? `Press ${shortcut} again to quit`
        : ready
          ? "Release to quit"
          : `Hold ${shortcut} to quit`}
      {state === "hold" && (
        <div className="mt-3 h-1 overflow-hidden rounded bg-muted">
          <div
            className="h-full origin-left bg-primary"
            style={{ animation: "quit-shortcut-progress 1s linear forwards" }}
          />
        </div>
      )}
    </div>,
    document.body,
  );
}
