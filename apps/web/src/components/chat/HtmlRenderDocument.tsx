import {
  htmlRenderResult,
  htmlRenderThemeMessage,
  htmlRenderThemeWindowName,
  isHtmlRenderEscape,
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
  readHtmlRenderPointerInside,
  type HtmlRenderTheme,
} from "@ryco/shared/htmlRender";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { useHtmlRenderTheme } from "~/themes/htmlRenderTheme";

/** Posts a theme to the frame's running page. */
function postTheme(frame: HTMLIFrameElement, theme: HtmlRenderTheme) {
  frame.contentWindow?.postMessage(htmlRenderThemeMessage(theme), "*");
}

/**
 * An agent's HTML render in the app theme. The page runs from `srcdoc` in a
 * sandbox without `allow-same-origin`, so its origin is opaque: it cannot
 * reach the app's session, storage or DOM, and it is never a URL a reader
 * could open outside the sandbox. A srcdoc page has no URL fragment, so it
 * reads its first theme from the frame's name before first paint, then
 * follows the theme messages posted to its bootstrap.
 */
export const HtmlRenderDocument = memo(function HtmlRenderDocument(props: {
  readonly html: string;
  readonly title: string;
  readonly className?: string;
  /** Receives the page's content height whenever it changes, so an inline frame can fit it. */
  readonly onContentHeight?: (height: number) => void;
  /**
   * Whether the reader's pointer is over the page. The page runs out of
   * process, so CSS :hover on the frame never matches; the page reports it.
   */
  readonly onPointerInside?: (inside: boolean) => void;
  /** The reader pressed Escape inside the page; its keys never reach the app. */
  readonly onEscape?: () => void;
}) {
  const theme = useHtmlRenderTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  // A new srcdoc or name would reload the page, so both keep their first value
  // for the frame's lifetime; later themes arrive as messages.
  const [initial] = useState(() => ({
    html: props.html,
    name: htmlRenderThemeWindowName(theme),
  }));
  const [loaded, setLoaded] = useState(false);

  // Runs once the page is in (covering a theme that changed while it loaded)
  // and on every later change.
  useEffect(() => {
    if (loaded && frameRef.current) postTheme(frameRef.current, theme);
  }, [loaded, theme]);

  // The page cannot open windows itself. It asks, and the link opens only
  // while this frame has focus and the reader has just used the app, so a page
  // cannot open links on load. Desktop sends `window.open` to the browser.
  useEffect(() => {
    const openLink = (event: MessageEvent) => {
      const frame = frameRef.current;
      const request = readHtmlRenderLinkRequest(event.data);
      if (
        request === undefined ||
        frame === null ||
        event.source !== frame.contentWindow ||
        document.activeElement !== frame ||
        navigator.userActivation?.isActive === false
      ) {
        return;
      }
      window.open(request.url, "_blank", "noopener,noreferrer");
      frame.contentWindow?.postMessage(htmlRenderResult(request.id), "*");
    };
    window.addEventListener("message", openLink);
    return () => window.removeEventListener("message", openLink);
  }, []);

  const { onContentHeight } = props;
  // A page posts its height once per change, so listen from the commit that
  // inserts the frame; a passive effect could miss a fast page's first post.
  // Its first report also shows it: the page is laid out by then, and `load`
  // can wait on a slow remote image or never fire at all.
  useLayoutEffect(() => {
    const resize = (event: MessageEvent) => {
      const height = readHtmlRenderContentHeight(event.data);
      if (height !== undefined && event.source === frameRef.current?.contentWindow) {
        setLoaded(true);
        onContentHeight?.(height);
      }
    };
    window.addEventListener("message", resize);
    return () => window.removeEventListener("message", resize);
  }, [onContentHeight]);

  const { onEscape } = props;
  useEffect(() => {
    if (onEscape === undefined) return;
    const escape = (event: MessageEvent) => {
      if (isHtmlRenderEscape(event.data) && event.source === frameRef.current?.contentWindow) {
        onEscape();
      }
    };
    window.addEventListener("message", escape);
    return () => window.removeEventListener("message", escape);
  }, [onEscape]);

  const { onPointerInside } = props;
  useEffect(() => {
    if (onPointerInside === undefined) return;
    const pointer = (event: MessageEvent) => {
      const inside = readHtmlRenderPointerInside(event.data);
      if (inside !== undefined && event.source === frameRef.current?.contentWindow) {
        onPointerInside(inside);
      }
    };
    window.addEventListener("message", pointer);
    return () => window.removeEventListener("message", pointer);
  }, [onPointerInside]);

  return (
    <iframe
      ref={frameRef}
      srcDoc={initial.html}
      name={initial.name}
      title={props.title}
      // Never allow-same-origin, allow-popups, allow-modals or top navigation:
      // the opaque origin keeps the page out of the app.
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
      onLoad={(event) => {
        // The first load hands over the theme from the effect. A page can
        // reload itself (a replay button, a meta refresh); its bootstrap
        // paints with the last theme it applied, kept in the frame's name, so
        // a later load only resyncs it (a theme change can race the reload).
        if (loaded) postTheme(event.currentTarget, theme);
        else setLoaded(true);
      }}
      // A frame whose color scheme differs from its document's paints an opaque
      // canvas, so the blank document a frame starts with would flash white in
      // dark mode. Once the page is in, its prefers-color-scheme follows the app.
      className={cn(
        "border-0 transition-opacity duration-(--app-motion-duration-pop) ease-(--app-motion-ease)",
        loaded ? "opacity-100" : "scheme-light opacity-0",
        props.className,
      )}
      style={loaded ? { colorScheme: theme.appearance } : undefined}
    />
  );
});
