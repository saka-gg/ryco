/**
 * Ryco Computer Use: the signed LSUIElement helper app macOS gives Computer Use's privacy grants
 * to (docs/superpowers/specs/2026-11-07-computer-use-helper-app.md). Build scripts and the dev
 * launcher read this to name and assemble the bundle; the desktop app finds the bundle by its
 * `RycoComputerUseProtocol` Info.plist key, not by name.
 *
 * Dependency-free: plain `.mjs` build scripts import this file directly.
 */

/** Wire protocol between Ryco's broker and the helper. The Swift helper declares the same number. */
export const COMPUTER_USE_HELPER_PROTOCOL = 1;

/** Info.plist key that marks a bundle as Ryco's Computer Use helper; its value is the protocol. */
export const COMPUTER_USE_HELPER_PROTOCOL_KEY = "RycoComputerUseProtocol";

/**
 * Info.plist key naming the directory the helper may start programs from. Only unpackaged builds
 * (the dev launcher) set it; a packaged helper uses `Contents/Resources` beside its `Helpers`.
 */
export const COMPUTER_USE_HELPER_RESOURCES_KEY = "RycoComputerUseResourcesDirectory";

/**
 * Info.plist key naming the code that may broker the helper (unpackaged builds: the dev launcher
 * wrapper). A packaged helper only accepts the Ryco.app whose `Contents/Helpers` holds it.
 */
export const COMPUTER_USE_HELPER_HOST_KEY = "RycoComputerUseHostPath";

/** The helper's main executable inside `Contents/MacOS`. */
export const COMPUTER_USE_HELPER_EXECUTABLE = "RycoComputerUse";

/** Where a packaged Ryco.app carries the helper, relative to its `Contents`. */
export const COMPUTER_USE_HELPER_CONTENTS_DIRECTORY = "Helpers";

export interface ComputerUseHelperAppIdentity {
  /** Bundle and display name, as System Settings lists it. */
  readonly name: string;
  readonly bundleId: string;
}

/** The helper's identity for a host app bundle id and product name. */
export function computerUseHelperAppIdentity(host: {
  readonly bundleId: string;
  /** "Ryco", "Ryco Nightly", or a dev launcher name such as "Ryco (Dev)". */
  readonly productName: string;
}): ComputerUseHelperAppIdentity {
  // "Ryco (Dev)" becomes "Ryco Computer Use (Dev)": the stage label stays at the end.
  const staged = /^(.*?)\s*(\([^()]+\))$/u.exec(host.productName);
  const name = staged
    ? `${staged[1]} Computer Use ${staged[2]}`
    : `${host.productName} Computer Use`;
  return { name, bundleId: `${host.bundleId}.computer-use` };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** The helper bundle's Info.plist (XML). */
export function computerUseHelperInfoPlist(input: {
  readonly identity: ComputerUseHelperAppIdentity;
  readonly version: string;
  /** File name of the icon in `Contents/Resources`, without extension. */
  readonly iconName: string;
  /** Unpackaged builds only: the directory the helper may start programs from. */
  readonly resourcesDirectory?: string;
  /** Unpackaged builds only: the app (or executable) that may broker the helper. */
  readonly hostPath?: string;
}): string {
  const product = input.identity.name;
  const entries: Array<readonly [string, string | number | boolean]> = [
    ["CFBundleDevelopmentRegion", "en"],
    ["CFBundleDisplayName", product],
    ["CFBundleExecutable", COMPUTER_USE_HELPER_EXECUTABLE],
    ["CFBundleIconFile", input.iconName],
    ["CFBundleIdentifier", input.identity.bundleId],
    ["CFBundleInfoDictionaryVersion", "6.0"],
    ["CFBundleName", product],
    ["CFBundlePackageType", "APPL"],
    ["CFBundleShortVersionString", input.version],
    ["CFBundleVersion", input.version],
    ["LSMinimumSystemVersion", "13.0"],
    // No Dock icon, no Cmd-Tab entry, no menu bar of its own.
    ["LSUIElement", true],
    ["NSHumanReadableCopyright", "Ryco"],
    [
      "NSAccessibilityUsageDescription",
      "Ryco Computer Use lets your agents click, type and read in the apps you allow.",
    ],
    [
      "NSScreenCaptureUsageDescription",
      "Ryco Computer Use lets your agents see the windows they work in. Pixels stay on this Mac.",
    ],
    [
      "NSInputMonitoringUsageDescription",
      "Optional: Ryco Computer Use watches for the Escape key so you can stop an agent at once.",
    ],
    [COMPUTER_USE_HELPER_PROTOCOL_KEY, COMPUTER_USE_HELPER_PROTOCOL],
    ...(input.resourcesDirectory
      ? [[COMPUTER_USE_HELPER_RESOURCES_KEY, input.resourcesDirectory] as const]
      : []),
    ...(input.hostPath ? [[COMPUTER_USE_HELPER_HOST_KEY, input.hostPath] as const] : []),
  ];
  const body = entries
    .map(([key, value]) => {
      const rendered =
        typeof value === "boolean"
          ? value
            ? "<true/>"
            : "<false/>"
          : typeof value === "number"
            ? `<integer>${value}</integer>`
            : `<string>${escapeXml(value)}</string>`;
      return `\t<key>${escapeXml(key)}</key>\n\t${rendered}`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`;
}
