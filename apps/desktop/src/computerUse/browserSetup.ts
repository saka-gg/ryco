import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ComputerBrowser } from "@ryco/contracts";

const targets = {
  chrome: {
    url: "chrome://extensions/",
    bundle: "com.google.Chrome",
    linux: ["google-chrome", "google-chrome-stable"],
    windows: ["Google", "Chrome", "Application", "chrome.exe"],
  },
  brave: {
    url: "brave://extensions/",
    bundle: "com.brave.Browser",
    linux: ["brave-browser", "brave"],
    windows: ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
  },
  edge: {
    url: "edge://extensions/",
    bundle: "com.microsoft.edgemac",
    linux: ["microsoft-edge", "microsoft-edge-stable"],
    windows: ["Microsoft", "Edge", "Application", "msedge.exe"],
  },
} as const;

export function browserSetupTarget(browser: ComputerBrowser) {
  if (browser === "ryco" || !Object.hasOwn(targets, browser))
    throw new Error("Choose Chrome, Brave or Edge.");
  return targets[browser];
}

/** User-triggered setup only. Never exposed through the agent's browser tool. */
export async function openBrowserExtensions(browser: ComputerBrowser): Promise<void> {
  const target = browserSetupTarget(browser);
  if (process.platform === "darwin") {
    try {
      await promisify(execFile)("/usr/bin/open", ["-b", target.bundle, target.url], {
        timeout: 5_000,
        maxBuffer: 64 * 1024,
      });
      return;
    } catch {
      throw new Error(
        "Could not open this browser. Install it first, or open its Extensions page manually.",
      );
    }
  }
  const candidates =
    process.platform === "win32"
      ? [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
          .filter((root): root is string => Boolean(root))
          .map((root) => join(root, ...target.windows))
          .filter(existsSync)
      : target.linux;
  for (const executable of candidates) {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(executable, [target.url], { detached: true, stdio: "ignore" });
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      });
      return;
    } catch {
      /* Try the next standard installation. */
    }
  }
  throw new Error("Could not find this browser. Open its Extensions page manually.");
}
