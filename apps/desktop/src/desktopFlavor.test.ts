import { describe, expect, it } from "vite-plus/test";

import { readDesktopFlavor } from "./desktopFlavor.ts";

const reading = (contents: string | Error) => (path: string) => {
  expect(path).toBe("/Applications/Ryco Nightly.app/Contents/Resources/app.asar/package.json");
  if (contents instanceof Error) throw contents;
  return contents;
};
const appPath = "/Applications/Ryco Nightly.app/Contents/Resources/app.asar";

describe("readDesktopFlavor", () => {
  it("reads the flavor the build wrote into the packaged package.json", () => {
    expect(
      readDesktopFlavor({
        appPath,
        isPackaged: true,
        readFile: reading(JSON.stringify({ name: "ryco-nightly", rycoDesktopFlavor: "nightly" })),
      }),
    ).toBe("nightly");
  });

  it("reads a build from before the split, or an unreadable file, as stable", () => {
    for (const contents of [JSON.stringify({ name: "ryco" }), "not json", new Error("ENOENT")]) {
      expect(readDesktopFlavor({ appPath, isPackaged: true, readFile: reading(contents) })).toBe(
        "stable",
      );
    }
  });

  it("treats an unpackaged (development) app as stable", () => {
    expect(
      readDesktopFlavor({
        appPath,
        isPackaged: false,
        readFile: () => JSON.stringify({ rycoDesktopFlavor: "nightly" }),
      }),
    ).toBe("stable");
  });
});
