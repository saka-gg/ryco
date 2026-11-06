import { describe, expect, it } from "vitest";

import { computerBrowserForAppIdentity } from "./computerBrowserIdentity.ts";

describe("computerBrowserForAppIdentity", () => {
  it("maps names, paths, executables and bundle ids to one browser", () => {
    expect(computerBrowserForAppIdentity("Google Chrome")).toBe("chrome");
    expect(computerBrowserForAppIdentity("/Applications/Google Chrome.app/")).toBe("chrome");
    expect(computerBrowserForAppIdentity("com.google.Chrome")).toBe("chrome");
    expect(computerBrowserForAppIdentity("C:\\Program Files\\Brave\\brave.exe")).toBe("brave");
    expect(computerBrowserForAppIdentity("com.microsoft.edgemac")).toBe("edge");
    expect(computerBrowserForAppIdentity("msedge")).toBe("edge");
  });

  it("leaves other apps alone", () => {
    expect(computerBrowserForAppIdentity("Safari")).toBeNull();
    expect(computerBrowserForAppIdentity("Chromium")).toBeNull();
    expect(computerBrowserForAppIdentity("")).toBeNull();
  });
});
