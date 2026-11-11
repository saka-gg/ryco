import * as FS from "node:fs";
import * as Path from "node:path";

import { APP_ICON_VARIANTS } from "@ryco/shared/appIcon";
import { describe, expect, it } from "vitest";

import { desktopAppIconResourceName, macDockIconAction } from "./appIcon.ts";

const RESOURCES_DIR = Path.join(import.meta.dirname, "../resources");

describe("desktopAppIconResourceName", () => {
  it("names the generated file per platform, and none for the app's own icon", () => {
    expect(desktopAppIconResourceName("light", "darwin")).toBeNull();
    expect(desktopAppIconResourceName("dark", "darwin")).toBe("app-icons/dark-macos.png");
    expect(desktopAppIconResourceName("ember", "win32")).toBe("app-icons/ember-windows.ico");
    expect(desktopAppIconResourceName("ignition", "linux")).toBe("app-icons/ignition-linux.png");
  });

  it("ships every variant's file for every platform", () => {
    for (const variant of APP_ICON_VARIANTS) {
      for (const platform of ["darwin", "win32", "linux"] as const) {
        const name = desktopAppIconResourceName(variant, platform);
        if (name === null) continue;
        expect(FS.existsSync(Path.join(RESOURCES_DIR, name)), name).toBe(true);
      }
    }
  });
});

describe("macDockIconAction", () => {
  const base = { defaultIconPath: "/icon.png", isPackaged: true, changedThisRun: false };

  it("shows a chosen variant", () => {
    expect(macDockIconAction({ ...base, variantPath: "/dark.png" })).toEqual({
      kind: "set",
      path: "/dark.png",
    });
  });

  it("leaves a packaged app's bundle icon alone until this run changed it, then restores it", () => {
    expect(macDockIconAction({ ...base, variantPath: null })).toBeNull();
    expect(macDockIconAction({ ...base, variantPath: null, changedThisRun: true })).toEqual({
      kind: "restore",
    });
  });

  it("gives a development build its own artwork", () => {
    expect(macDockIconAction({ ...base, variantPath: null, isPackaged: false })).toEqual({
      kind: "set",
      path: "/icon.png",
    });
  });
});
