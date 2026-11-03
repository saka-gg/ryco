/**
 * The load-bearing containment of the terminal WebView. It runs JavaScript,
 * unlike the static file preview, so the document is app-owned and generated
 * (`scripts/build-terminal-renderer.mts`), its CSP admits exactly its own
 * script, and every capability below stays off.
 */
export const TERMINAL_RENDERER_ALLOWED_INITIAL_URL = "about:blank";

export const TERMINAL_WEBVIEW_SECURITY_PROPS = {
  javaScriptEnabled: true,
  incognito: true,
  cacheEnabled: false,
  domStorageEnabled: false,
  allowFileAccess: false,
  allowFileAccessFromFileURLs: false,
  allowUniversalAccessFromFileURLs: false,
  sharedCookiesEnabled: false,
  thirdPartyCookiesEnabled: false,
  setSupportMultipleWindows: false,
  allowsInlineMediaPlayback: false,
  mediaPlaybackRequiresUserAction: true,
  allowsLinkPreview: false,
  dataDetectorTypes: "none",
} as const;

/** The string-backed document has only its initial about: lifecycle. */
export function isAllowedTerminalRendererNavigation(url: string): boolean {
  return url.length === 0 || url.toLowerCase() === TERMINAL_RENDERER_ALLOWED_INITIAL_URL;
}
