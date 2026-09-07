import { expect, it } from "vitest";
import type { ComputerBrowser } from "@ryco/contracts";
import { browserSetupTarget } from "./browserSetup.ts";

it("opens the selected browser's own extension manager", () => {
  expect(browserSetupTarget("chrome")).toMatchObject({
    bundle: "com.google.Chrome",
    url: "chrome://extensions/",
  });
  expect(browserSetupTarget("brave")).toMatchObject({
    bundle: "com.brave.Browser",
    url: "brave://extensions/",
  });
  expect(browserSetupTarget("edge")).toMatchObject({
    bundle: "com.microsoft.edgemac",
    url: "edge://extensions/",
  });
  expect(() => browserSetupTarget("ryco")).toThrow("Choose");
  expect(() => browserSetupTarget("constructor" as ComputerBrowser)).toThrow("Choose");
});
