import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@ryco/contracts";

import {
  resolveCanonicalPrimaryEnvironmentId,
  shouldApplyBootstrapThreadRedirect,
} from "./RootAppShell.logic";

const HUB_ENVIRONMENT_ID = EnvironmentId.make("env_aaaaaaaaaaaaaaaaaaaaaa");
const SERVER_ENVIRONMENT_ID = EnvironmentId.make("server-environment-id");

describe("shouldApplyBootstrapThreadRedirect", () => {
  it("keeps hosted home in place while discovering device thread lists", () => {
    expect(
      shouldApplyBootstrapThreadRedirect({ pathname: "/", tier: "desktop", hostedHome: true }),
    ).toBe(false);
  });
  it("keeps the desktop last-thread redirect at the logical root", () => {
    expect(shouldApplyBootstrapThreadRedirect({ pathname: "/", tier: "desktop" })).toBe(true);
  });

  it("never redirects away from a non-root route", () => {
    expect(shouldApplyBootstrapThreadRedirect({ pathname: "/env_a/t_1", tier: "desktop" })).toBe(
      false,
    );
    expect(shouldApplyBootstrapThreadRedirect({ pathname: "/env_a/t_1", tier: "phone" })).toBe(
      false,
    );
  });

  it("keeps the phone tier on Home instead of the last thread", () => {
    expect(shouldApplyBootstrapThreadRedirect({ pathname: "/", tier: "phone" })).toBe(false);
  });
});

describe("resolveCanonicalPrimaryEnvironmentId", () => {
  it("uses the server-reported identity for a direct connection", () => {
    expect(
      resolveCanonicalPrimaryEnvironmentId({
        hosted: false,
        primaryEnvironmentId: HUB_ENVIRONMENT_ID,
        serverEnvironmentId: SERVER_ENVIRONMENT_ID,
      }),
    ).toBe(SERVER_ENVIRONMENT_ID);
  });

  it("keeps the Hub identity canonical when the hosted server reports a different identity", () => {
    expect(
      resolveCanonicalPrimaryEnvironmentId({
        hosted: true,
        primaryEnvironmentId: HUB_ENVIRONMENT_ID,
        serverEnvironmentId: SERVER_ENVIRONMENT_ID,
      }),
    ).toBe(HUB_ENVIRONMENT_ID);
  });

  it("does not fall back to the server identity before hosted lifecycle ownership is published", () => {
    expect(
      resolveCanonicalPrimaryEnvironmentId({
        hosted: true,
        primaryEnvironmentId: null,
        serverEnvironmentId: SERVER_ENVIRONMENT_ID,
      }),
    ).toBeNull();
  });
});
