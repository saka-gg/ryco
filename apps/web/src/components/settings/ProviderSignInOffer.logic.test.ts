import { ProviderDriverKind, type ProviderInstanceConfig } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { claudeInstanceSkipsLogin, instanceOffersSignIn } from "./ProviderSignInOffer.logic";

function settings(driver: string, names: readonly string[] = []): ProviderInstanceConfig {
  return {
    driver: ProviderDriverKind.make(driver),
    // What a client gets for a sensitive variable: the name, and no value.
    environment: names.map((name) => ({ name, value: "", sensitive: true, valueRedacted: true })),
  };
}

describe("claudeInstanceSkipsLogin", () => {
  it("reads the non-login credentials and provider flags by name", () => {
    expect(claudeInstanceSkipsLogin(settings("claudeAgent", ["ANTHROPIC_BASE_URL"]))).toBe(true);
    expect(claudeInstanceSkipsLogin(settings("claudeAgent", ["ANTHROPIC_API_KEY"]))).toBe(true);
    expect(claudeInstanceSkipsLogin(settings("claudeAgent", ["CLAUDE_CODE_USE_VERTEX"]))).toBe(
      true,
    );
    expect(
      claudeInstanceSkipsLogin(settings("claudeAgent", ["CLAUDE_CONFIG_DIR", "HTTPS_PROXY"])),
    ).toBe(false);
  });

  it("finds nothing without settings or variables", () => {
    expect(claudeInstanceSkipsLogin(undefined)).toBe(false);
    expect(claudeInstanceSkipsLogin({ driver: ProviderDriverKind.make("claudeAgent") })).toBe(
      false,
    );
  });
});

describe("instanceOffersSignIn", () => {
  it("offers the drivers that sign in from Ryco", () => {
    for (const driver of ["codex", "claudeAgent", "cursor", "grok", "opencode"]) {
      expect(instanceOffersSignIn(driver, settings(driver)), driver).toBe(true);
      expect(instanceOffersSignIn(driver, undefined), driver).toBe(true);
    }
    expect(instanceOffersSignIn("acpRegistry", settings("acpRegistry"))).toBe(false);
    expect(instanceOffersSignIn("copilot", settings("copilot"))).toBe(false);
  });

  it("leaves a Claude instance routed past the login alone, such as a CLIProxyAPI hub's", () => {
    const hub = settings("claudeAgent", ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]);
    expect(instanceOffersSignIn("claudeAgent", hub)).toBe(false);
    // The same variable on another driver means nothing to its login.
    expect(instanceOffersSignIn("codex", settings("codex", ["ANTHROPIC_BASE_URL"]))).toBe(true);
  });
});
