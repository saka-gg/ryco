import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "./index.css";

import { isElectron, isHostedHubMode } from "./env";
import { startHostedAccessCheck } from "./hostedHub/bootGate";
import { installHostedNodeHistory } from "./hostedHub/nodeRoutes";
import { hostedPwaLifecycle } from "./pwa/lifecycle";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";
import { hubPageTitle } from "./hubBranding";
import { syncDocumentHubSurface } from "./lib/hubSurface";
import { syncDocumentPresentationTier } from "./lib/presentationTier";
import { syncDocumentVisualViewportInsets } from "./lib/visualViewportInsets";
import { syncAppearancePreferenceEnvironment } from "./themes/appearancePreferences";
import { isWindowTranslucencySupported } from "./themes/windowTranslucency";
import { syncDocumentWindowControlsOverlayClass } from "./lib/windowControlsOverlay";
import { initializeWsConnectionState } from "./rpc/wsConnectionState";
import { syncDocumentMotionVisibility } from "./lib/perf/motion";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
// Hosted-hub builds scope browser URLs under the selected node's stable route
// segment while the logical route tree stays shared; other modes are untouched.
const history = isElectron
  ? createHashHistory()
  : isHostedHubMode()
    ? installHostedNodeHistory()
    : createBrowserHistory();

// Hosted builds send the access check (the session restore and the directory
// read beside it) before the router exists: the root `beforeLoad` and the route
// and shell chunks it downloads all come after it, and that `beforeLoad` waits
// for this same check instead of sending another.
if (isHostedHubMode()) startHostedAccessCheck();

const router = getRouter(history);
const DesktopQuitFeedback = React.lazy(() =>
  import("./components/QuitShortcutFeedback").then((module) => ({
    default: module.QuitShortcutFeedback,
  })),
);

initializeWsConnectionState();
syncDocumentMotionVisibility();

if (isElectron) {
  syncDocumentWindowControlsOverlayClass();
}

// Marks this document as the Hub website in hosted-hub builds only, so the
// standalone Hub design is scoped to a surface the node/desktop build never
// stamps. Runs before the first paint and before the tier sync, since Hub
// chrome reads both.
syncDocumentHubSurface();

// The single presentation-tier classification: stamps data-tier on the root
// element so tier-critical CSS and JS agree everywhere, including the hosted
// root and /pair subtrees.
syncDocumentPresentationTier();

// The single VisualViewport subscription: publishes bounded keyboard-inset CSS
// variables that phone input surfaces consume from CSS only.
syncDocumentVisualViewportInsets();

// Reapplies the appearance variables when an environment input that feeds the
// effective preferences changes — the presentation tier, reduced transparency,
// reduced motion — without ever writing a stored value.
syncAppearancePreferenceEnvironment();

// The Hub is its own product, not a view of the desktop client, so it does not
// wear the desktop app's name or release-channel suffix. Per-page titles are
// set by the Hub routes themselves; this is the boot title and the fallback.
document.title = isHostedHubMode() ? hubPageTitle() : APP_DISPLAY_NAME;

if (hostedPwaLifecycle) {
  void hostedPwaLifecycle.start({ enabled: import.meta.env.PROD && isHostedHubMode() });
}

const rootElement = document.getElementById("root") as HTMLElement;

// On a translucent window, floating overlays get the page cut out from under
// them (the macOS desktop only; inert while the window is opaque). Only that
// window loads the cutout. It is paint-only: an overlay already open when it
// lands is cut out as it installs, and a failed load only leaves the page
// visible through the overlays' glass.
if (isWindowTranslucencySupported()) {
  let disposeGlassOverlayCutout: (() => void) | null = null;
  let disposed = false;
  void import("./lib/glassOverlayCutout")
    .then(({ installGlassOverlayCutout }) => {
      if (!disposed) disposeGlassOverlayCutout = installGlassOverlayCutout(rootElement);
    })
    .catch((error: unknown) => {
      console.warn("The translucent window's overlay cutout did not start.", error);
    });
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      disposed = true;
      disposeGlassOverlayCutout?.();
    });
  }
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
    {isElectron && (
      <React.Suspense fallback={null}>
        <DesktopQuitFeedback />
      </React.Suspense>
    )}
  </React.StrictMode>,
);
