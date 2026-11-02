import type { DesktopAppBranding, DesktopAppStageLabel } from "@ryco/contracts";

import { type RycoDesktopFlavor, rycoDesktopFlavorIdentity } from "@ryco/shared/desktopFlavor";

import { isNightlyDesktopVersion } from "./updateChannels.ts";

const APP_BASE_NAME = "Ryco";

export function resolveDesktopAppStageLabel(input: {
  readonly isDevelopment: boolean;
  readonly appVersion: string;
}): DesktopAppStageLabel {
  if (input.isDevelopment) {
    return "Dev";
  }

  return isNightlyDesktopVersion(input.appVersion) ? "Nightly" : "Beta";
}

export function resolveDesktopAppBranding(input: {
  readonly isDevelopment: boolean;
  readonly appVersion: string;
  readonly flavor?: RycoDesktopFlavor;
}): DesktopAppBranding {
  // Ryco Nightly is its own app, named like its bundle.
  if (!input.isDevelopment && input.flavor === "nightly") {
    return {
      baseName: APP_BASE_NAME,
      stageLabel: "Nightly",
      displayName: rycoDesktopFlavorIdentity("nightly").productName,
    };
  }
  const stageLabel = resolveDesktopAppStageLabel(input);
  return {
    baseName: APP_BASE_NAME,
    stageLabel,
    displayName: `${APP_BASE_NAME} (${stageLabel})`,
  };
}
