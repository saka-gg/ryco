/** A desktop browser Computer Use can drive through its own app and through browser routes. */
export type ComputerDesktopBrowser = "chrome" | "brave" | "edge";

/**
 * One canonical identity per browser: the names, executables and bundle ids it appears under.
 * App denial (legacy controls) and per-app approval both key on it, so "Google Chrome",
 * `chrome`, `google-chrome` and `com.google.Chrome` are the same app everywhere.
 */
export const COMPUTER_BROWSER_IDENTITIES: Readonly<
  Record<ComputerDesktopBrowser, { readonly name: string; readonly aliases: readonly string[] }>
> = {
  chrome: {
    name: "Google Chrome",
    aliases: [
      "google chrome",
      "chrome",
      "google-chrome",
      "google-chrome-stable",
      "com.google.chrome",
    ],
  },
  brave: {
    name: "Brave Browser",
    aliases: ["brave browser", "brave", "brave-browser", "com.brave.browser"],
  },
  edge: {
    name: "Microsoft Edge",
    aliases: [
      "microsoft edge",
      "msedge",
      "microsoft-edge",
      "microsoft-edge-stable",
      "com.microsoft.edgemac",
    ],
  },
};

/** The browser an app identity (name, path, executable or bundle id) belongs to, if any. */
export function computerBrowserForAppIdentity(identity: string): ComputerDesktopBrowser | null {
  const leaf = identity
    .replaceAll("\\", "/")
    .replace(/\/+$/u, "")
    .split("/")
    .pop()
    ?.replace(/\.(app|exe)$/iu, "")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
  if (!leaf) return null;
  for (const [browser, entry] of Object.entries(COMPUTER_BROWSER_IDENTITIES))
    if (entry.aliases.includes(leaf)) return browser as ComputerDesktopBrowser;
  return null;
}
