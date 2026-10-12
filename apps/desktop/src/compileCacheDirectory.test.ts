import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  pruneStaleDesktopCompileCaches,
  resolveDesktopCompileCacheDir,
  shouldUseDesktopCompileCache,
} from "./compileCacheDirectory.ts";

describe("desktop compile cache directory", () => {
  it("keeps one directory per app version under userData", () => {
    expect(
      resolveDesktopCompileCacheDir(
        "/Users/me/Library/Application Support/ryco",
        "0.1.32-nightly.4",
      ),
    ).toBe("/Users/me/Library/Application Support/ryco/compile-cache/0.1.32-nightly.4");
    expect(resolveDesktopCompileCacheDir("/data", "1.0.0/../x")).toBe(
      "/data/compile-cache/1.0.0_.._x",
    );
  });

  it("is only used by packaged builds that are not AppImages", () => {
    expect(shouldUseDesktopCompileCache({ isPackaged: true, env: {} })).toBe(true);
    expect(shouldUseDesktopCompileCache({ isPackaged: false, env: {} })).toBe(false);
    expect(
      shouldUseDesktopCompileCache({ isPackaged: true, env: { APPIMAGE: "/tmp/Ryco.AppImage" } }),
    ).toBe(false);
  });

  it("prunes caches of earlier versions and keeps the current one", async () => {
    const userData = FS.mkdtempSync(Path.join(OS.tmpdir(), "ryco-compile-cache-test-"));
    try {
      const current = resolveDesktopCompileCacheDir(userData, "2.0.0");
      for (const version of ["1.0.0", "1.9.9", "2.0.0"]) {
        FS.mkdirSync(Path.join(userData, "compile-cache", version, "v24"), { recursive: true });
      }
      await expect(pruneStaleDesktopCompileCaches(current)).resolves.toBe(2);
      expect(FS.readdirSync(Path.join(userData, "compile-cache"))).toEqual(["2.0.0"]);
      await expect(
        pruneStaleDesktopCompileCaches(Path.join(userData, "missing", "1")),
      ).resolves.toBe(0);
    } finally {
      FS.rmSync(userData, { recursive: true, force: true });
    }
  });
});
