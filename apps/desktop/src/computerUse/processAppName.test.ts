import { expect, it } from "vitest";
import { appNameFromExecutablePath } from "./processAppName.ts";

it("names the outermost app bundle, else the executable", () => {
  expect(appNameFromExecutablePath("/Applications/Safari.app/Contents/MacOS/Safari\n")).toBe(
    "Safari",
  );
  expect(
    appNameFromExecutablePath(
      "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper",
    ),
  ).toBe("Google Chrome");
  expect(appNameFromExecutablePath("/usr/bin/some-tool")).toBe("some-tool");
  expect(appNameFromExecutablePath("  ")).toBeNull();
});
