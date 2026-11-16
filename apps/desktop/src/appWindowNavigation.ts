/**
 * Whether the app window may move its top frame to `url`: a desktop document (boot page or
 * desktop-scheme app URL) or a page on one of the app's own origins (backend, dev server).
 * Any other document would inherit the preload bridge.
 */
export function isAppWindowNavigationAllowed(input: {
  readonly url: string;
  readonly appUrls: readonly string[];
  readonly isDesktopDocumentUrl: (url: string) => boolean;
}): boolean {
  if (input.isDesktopDocumentUrl(input.url)) return true;
  const origin = urlOrigin(input.url);
  if (origin === null) return false;
  return input.appUrls.some((appUrl) => urlOrigin(appUrl) === origin);
}

function urlOrigin(raw: string): string | null {
  if (raw.length === 0) return null;
  try {
    const origin = new URL(raw).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}
