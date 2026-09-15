import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
const fixture = vi.hoisted(() => ({
  hosted: false,
  static: false,
  target: "http://localhost:3773",
}));
vi.mock("../../env", () => ({ isHostedHubMode: () => fixture.hosted }));
vi.mock("../../hostedPairing", () => ({ isHostedStaticApp: () => fixture.static }));
vi.mock("../../environments/primary/target", async (original) => ({
  ...(await original<typeof import("../../environments/primary/target")>()),
  readPrimaryEnvironmentTarget: () => ({ target: { httpBaseUrl: fixture.target } }),
}));
import { isLocalOnboardingClient } from "./localOnboarding";
beforeEach(() => {
  vi.stubGlobal("window", {});
  fixture.hosted = false;
  fixture.static = false;
  fixture.target = "http://localhost:3773";
});
describe("local onboarding eligibility", () => {
  it("accepts loopback primary nodes", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      fixture.target = `http://${host}:3773`;
      expect(isLocalOnboardingClient()).toBe(true);
    }
  });
  it("excludes Hub, static hosted and remote primary nodes", () => {
    fixture.hosted = true;
    expect(isLocalOnboardingClient()).toBe(false);
    fixture.hosted = false;
    fixture.static = true;
    expect(isLocalOnboardingClient()).toBe(false);
    fixture.static = false;
    fixture.target = "https://remote.example";
    expect(isLocalOnboardingClient()).toBe(false);
    fixture.target = "invalid";
    expect(isLocalOnboardingClient()).toBe(false);
  });
});
