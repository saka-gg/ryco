import type { DesktopAppSnapWindowEntry, DesktopBridge } from "@ryco/contracts";
import { AppWindowIcon, ArrowLeftIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { windowCaptureErrorMessage } from "~/windowCapture";
import { Button } from "../ui/button";

type WindowCapturePickerState =
  | { readonly kind: "loading" }
  | { readonly kind: "setup"; readonly appName: string }
  | { readonly kind: "windows"; readonly windows: readonly DesktopAppSnapWindowEntry[] }
  | { readonly kind: "error"; readonly message: string };

type WindowCaptureBridge = NonNullable<DesktopBridge["windowCapture"]>;

async function readWindowCapturePicker(
  bridge: WindowCaptureBridge,
): Promise<WindowCapturePickerState> {
  try {
    const captureState = await bridge.getState();
    // An unknown grant could not be checked; listing then reports why.
    if (
      captureState.missingPermissions.includes("screenRecording") &&
      captureState.screenRecordingPermission !== "unknown"
    ) {
      return { kind: "setup", appName: captureState.appDisplayName || "Ryco" };
    }
    return { kind: "windows", windows: await bridge.listWindows() };
  } catch (error) {
    return { kind: "error", message: windowCaptureErrorMessage(error) };
  }
}

/**
 * Lists the windows the desktop app can capture. Missing Screen Recording
 * shows the existing permission setup instead; returning to the app re-checks.
 */
function useWindowCapturePicker() {
  const bridge = window.desktopBridge?.windowCapture;
  const [state, setState] = useState<WindowCapturePickerState>({ kind: "loading" });
  const [setupBusy, setSetupBusy] = useState(false);
  const generationRef = useRef(0);

  const load = useCallback(() => {
    if (!bridge) return;
    const generation = ++generationRef.current;
    void readWindowCapturePicker(bridge).then((next) => {
      if (generation === generationRef.current) setState(next);
    });
  }, [bridge]);

  useEffect(() => {
    load();
    return () => {
      generationRef.current += 1;
    };
  }, [load]);

  const waitingForGrant = state.kind === "setup";
  useEffect(() => {
    if (!waitingForGrant || !bridge) return;
    const unsubscribe = bridge.onState((next) => {
      if (!next.missingPermissions.includes("screenRecording")) load();
    });
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", onFocus);
    };
  }, [bridge, load, waitingForGrant]);

  const setup = useCallback(() => {
    if (!bridge) return;
    setSetupBusy(true);
    // The picker needs Screen Recording alone, whatever shortcut is saved.
    void bridge
      .setup(["screenRecording"])
      .catch((error: unknown) =>
        setState({ kind: "error", message: windowCaptureErrorMessage(error) }),
      )
      .finally(() => setSetupBusy(false));
  }, [bridge]);

  const retry = useCallback(() => {
    setState({ kind: "loading" });
    load();
  }, [load]);

  return { state, setupBusy, setup, retry };
}

function WindowEntryIcon({ entry }: { entry: DesktopAppSnapWindowEntry }) {
  return entry.appIconDataUrl ? (
    <img src={entry.appIconDataUrl} alt="" className="size-4 shrink-0 rounded-[4px]" />
  ) : (
    <AppWindowIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
  );
}

export function WindowCapturePicker(props: {
  onBack: () => void;
  onSelect: (windowId: number) => void;
}) {
  const { state, setupBusy, setup, retry } = useWindowCapturePicker();
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-2">
        <button
          type="button"
          aria-label="Back to context"
          className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
          onClick={props.onBack}
        >
          <ArrowLeftIcon className="size-4" />
        </button>
        <span className="text-sm font-medium">Capture window</span>
      </div>
      {state.kind === "loading" ? (
        <p className="px-3 py-4 text-xs text-muted-foreground">Loading windows…</p>
      ) : state.kind === "setup" ? (
        <div className="flex flex-col items-start gap-2 px-3 py-3">
          <p className="text-xs text-muted-foreground">
            {`Allow Screen Recording for ${state.appName} in System Settings to capture windows.`}
          </p>
          <Button type="button" size="xs" disabled={setupBusy} onClick={setup}>
            Set up
          </Button>
        </div>
      ) : state.kind === "error" ? (
        <div className="flex flex-col items-start gap-2 px-3 py-3">
          <p role="alert" className="text-xs text-muted-foreground">
            {state.message}
          </p>
          <Button type="button" size="xs" variant="outline" onClick={retry}>
            Try again
          </Button>
        </div>
      ) : state.windows.length === 0 ? (
        <p className="px-3 py-4 text-xs text-muted-foreground">No other windows are open.</p>
      ) : (
        <ul className="max-h-72 overflow-y-auto py-1" aria-label="Windows">
          {state.windows.map((entry) => {
            const appName = entry.appName?.trim() || "Window";
            const title = entry.windowTitle?.trim();
            return (
              <li key={entry.windowId}>
                <button
                  type="button"
                  aria-label={title ? `Capture ${appName}: ${title}` : `Capture ${appName}`}
                  onClick={() => props.onSelect(entry.windowId)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm",
                    "hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
                  )}
                >
                  <WindowEntryIcon entry={entry} />
                  <span className="shrink-0 font-medium">{appName}</span>
                  {title && title !== appName ? (
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {title}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
