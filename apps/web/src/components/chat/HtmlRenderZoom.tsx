import type { HtmlRenderZoomRequest } from "@ryco/shared/htmlRender";
import {
  fitHtmlRenderZoom,
  formatHtmlRenderZoom,
  scaleHtmlRenderZoom,
  stepHtmlRenderZoom,
  wheelHtmlRenderZoom,
  type HtmlRenderContentWidth,
} from "@ryco/shared/htmlRenderZoom";
import { MinusIcon, MoveHorizontalIcon, PlusIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { isMacPlatform } from "~/lib/utils";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useHtmlRenderZoomSetting } from "./htmlRenderZoomStore";

/**
 * Zoom of an agent page shown at full size (the expanded view, the page tab):
 * buttons, Cmd/Ctrl + / − / 0 while the page or its view has focus, and a
 * pinch or Ctrl+wheel over it. The level is the page's own for the session
 * (`htmlRenderZoomStore`). "Fit width" follows the view's width.
 */
export interface HtmlRenderZoom {
  /** The zoom the page is shown at now. */
  readonly zoom: number;
  readonly fitting: boolean;
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
  readonly reset: () => void;
  readonly fitWidth: () => void;
  /** A request from inside the page (its keys and pinches never reach the app). */
  readonly onZoomRequest: (request: HtmlRenderZoomRequest) => void;
  /** The page's latest width report, for fitting it. */
  readonly onContentWidth: (content: HtmlRenderContentWidth) => void;
  /** Attaches the page's box: its width is what "fit" fits, and a pinch over it zooms. */
  readonly attachBox: (element: HTMLElement | null) => void;
  /** Cmd/Ctrl + / − / 0 while focus is in the page's view (outside the page itself). */
  readonly onKeyDown: (event: ReactKeyboardEvent) => void;
}

/** Which zoom a Cmd/Ctrl key asks for, if any. */
export function htmlRenderZoomKeyAction(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">,
): "in" | "out" | "reset" | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  if (event.key === "+" || event.key === "=") return "in";
  if (event.key === "-" || event.key === "_") return "out";
  if (event.key === "0") return "reset";
  return null;
}

export function useHtmlRenderZoom(zoomKey: string | null): HtmlRenderZoom {
  const [setting, write] = useHtmlRenderZoomSetting(zoomKey);
  const [box, setBox] = useState<HTMLElement | null>(null);
  const [boxWidth, setBoxWidth] = useState(0);
  const [content, setContent] = useState<HtmlRenderContentWidth>();
  // The zoom "fit" settled on, and the box width it last tried 100% at: a
  // page that fits at a narrow zoom is tried once at 100% per width, to see
  // whether it fits there too.
  const [fit, setFit] = useState<{ readonly zoom: number; readonly probedAt: number | null }>({
    zoom: 1,
    probedAt: null,
  });
  const fitting = setting.mode === "fit";
  const zoom = fitting ? fit.zoom : setting.zoom;

  useEffect(() => {
    if (box === null) return;
    // Its first report is the box's size as observing starts.
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setBoxWidth(entry.contentRect.width);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [box]);

  useEffect(() => {
    if (!fitting || boxWidth <= 0) return;
    const next = fitHtmlRenderZoom({ boxWidth, zoom: fit.zoom, content });
    if (next !== null) {
      if (Math.abs(next - fit.zoom) > 1e-3) setFit({ zoom: next, probedAt: fit.probedAt });
    } else if (fit.probedAt !== boxWidth) {
      setFit({ zoom: 1, probedAt: boxWidth });
    }
  }, [boxWidth, content, fit, fitting]);

  const setZoom = useCallback((next: number) => write({ mode: "zoom", zoom: next }), [write]);
  const zoomIn = () => setZoom(stepHtmlRenderZoom(zoom, 1));
  const zoomOut = () => setZoom(stepHtmlRenderZoom(zoom, -1));
  const reset = () => setZoom(1);
  const fitWidth = () => {
    if (fitting) {
      setZoom(1);
      return;
    }
    setFit({ zoom, probedAt: null });
    write({ mode: "fit" });
  };
  const onZoomRequest = (request: HtmlRenderZoomRequest) => {
    if (request.action === "in") zoomIn();
    else if (request.action === "out") zoomOut();
    else if (request.action === "reset") reset();
    else if (request.action === "wheel") setZoom(wheelHtmlRenderZoom(zoom, request.deltaY));
    else if (request.action === "scale") setZoom(scaleHtmlRenderZoom(zoom, request.factor));
  };

  // A pinch or Ctrl+wheel over the page's gutter: the page reports its own.
  // React's wheel listener is passive, so the browser's zoom is held back here.
  const onWheel = useEffectEvent((event: WheelEvent) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    setZoom(wheelHtmlRenderZoom(zoom, event.deltaY));
  });
  useEffect(() => {
    if (box === null) return;
    const listener = (event: WheelEvent) => onWheel(event);
    box.addEventListener("wheel", listener, { passive: false });
    return () => box.removeEventListener("wheel", listener);
  }, [box]);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    const action = htmlRenderZoomKeyAction(event);
    if (action === null) return;
    event.preventDefault();
    event.stopPropagation();
    onZoomRequest({ action });
  };

  return {
    zoom,
    fitting,
    zoomIn,
    zoomOut,
    reset,
    fitWidth,
    onZoomRequest,
    onContentWidth: setContent,
    attachBox: setBox,
    onKeyDown,
  };
}

function ZoomButton(props: {
  readonly label: string;
  readonly shortcut: string;
  readonly disabled?: boolean | undefined;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={props.label}
            variant="outline"
            size="icon-sm"
            disabled={props.disabled}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>
        {props.label} <span className="ms-1 text-muted-foreground">{props.shortcut}</span>
      </TooltipPopup>
    </Tooltip>
  );
}

/** Zoom out, the level (resets on click), zoom in, and Fit width: beside Source and Download. */
export function HtmlRenderZoomControls(props: {
  readonly zoom: HtmlRenderZoom;
  readonly disabled?: boolean | undefined;
}) {
  const { zoom } = props;
  const modifier = isMacPlatform(navigator.platform) ? "⌘" : "Ctrl+";
  return (
    <>
      <Group aria-label="Zoom">
        <ZoomButton
          label="Zoom out"
          shortcut={`${modifier}−`}
          disabled={props.disabled}
          onClick={zoom.zoomOut}
        >
          <MinusIcon className="size-3.5" />
        </ZoomButton>
        <GroupSeparator />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={`Zoom ${formatHtmlRenderZoom(zoom.zoom)}, reset to 100%`}
                variant="outline"
                size="sm"
                disabled={props.disabled}
                onClick={zoom.reset}
                className="w-14 px-0 tabular-nums"
              />
            }
          >
            {formatHtmlRenderZoom(zoom.zoom)}
          </TooltipTrigger>
          <TooltipPopup>
            Reset to 100% <span className="ms-1 text-muted-foreground">{modifier}0</span>
          </TooltipPopup>
        </Tooltip>
        <GroupSeparator />
        <ZoomButton
          label="Zoom in"
          shortcut={`${modifier}+`}
          disabled={props.disabled}
          onClick={zoom.zoomIn}
        >
          <PlusIcon className="size-3.5" />
        </ZoomButton>
      </Group>
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              aria-label="Fit width"
              variant="outline"
              size="sm"
              pressed={zoom.fitting}
              disabled={props.disabled}
              onPressedChange={() => zoom.fitWidth()}
            />
          }
        >
          <MoveHorizontalIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup>Fit the page's width</TooltipPopup>
      </Tooltip>
    </>
  );
}
