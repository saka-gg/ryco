import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@ryco/contracts";
import { PROVIDER_SIGN_IN_DRIVERS } from "@ryco/shared/providerSignIn";
import { describe, expect, it } from "vite-plus/test";

import { canOfferOnboardingSignIn, claudeInstanceSkipsLogin } from "./onboardingSignIn.logic";

function snapshot(
  driver: string,
  auth: ServerProvider["auth"],
  patch: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver.toLowerCase()),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth,
    checkedAt: "2026-10-28T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...patch,
  };
}

function settings(driver: string, names: readonly string[] = []): ProviderInstanceConfig {
  return {
    driver: ProviderDriverKind.make(driver),
    // What a client gets for a sensitive variable: the name, and no value.
    environment: names.map((name) => ({ name, value: "", sensitive: true, valueRedacted: true })),
  };
}

function offer(
  provider: ServerProvider,
  instance: ProviderInstanceConfig | undefined = undefined,
  capabilityAllowed = true,
) {
  return canOfferOnboardingSignIn({ provider, instance, capabilityAllowed });
}

const SIGNED_OUT = { status: "unauthenticated" } as const;
const claudeSignsIn = PROVIDER_SIGN_IN_DRIVERS.has("claudeAgent");

describe("canOfferOnboardingSignIn", () => {
  it("offers Codex while it reports no sign-in", () => {
    expect(offer(snapshot("codex", SIGNED_OUT))).toBe(true);
    expect(offer(snapshot("codex", { status: "unknown" }, { status: "error" }))).toBe(true);
    expect(offer(snapshot("codex", { status: "authenticated", email: "a@example.com" }))).toBe(
      false,
    );
  });

  it("leaves a Codex on a custom model provider alone: it is ready without an account", () => {
    expect(offer(snapshot("codex", { status: "unknown" }))).toBe(false);
  });

  it("offers a Claude instance that started without an account, once Claude signs in from Ryco", () => {
    expect(offer(snapshot("claudeAgent", { status: "authenticated" }))).toBe(claudeSignsIn);
    expect(
      offer(
        snapshot("claudeAgent", { status: "authenticated" }),
        settings("claudeAgent", ["HOME"]),
      ),
    ).toBe(claudeSignsIn);
    expect(
      offer(snapshot("claudeAgent", { status: "authenticated", email: "a@example.com" })),
    ).toBe(false);
    expect(
      offer(snapshot("claudeAgent", { status: "authenticated", type: "max", label: "Claude Max" })),
    ).toBe(false);
  });

  it("never offers a Claude instance whose settings route it past the login", () => {
    const signedOut = snapshot("claudeAgent", { status: "authenticated" });
    expect(offer(signedOut, settings("claudeAgent", ["ANTHROPIC_BASE_URL"]))).toBe(false);
    expect(
      offer(signedOut, settings("claudeAgent", ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"])),
    ).toBe(false);
    expect(offer(signedOut, settings("claudeAgent", ["CLAUDE_CODE_USE_BEDROCK"]))).toBe(false);
  });

  it("offers nothing for an instance that does not run", () => {
    expect(offer(snapshot("codex", SIGNED_OUT, { installed: false }))).toBe(false);
    expect(offer(snapshot("codex", SIGNED_OUT, { enabled: false }))).toBe(false);
    expect(offer(snapshot("codex", SIGNED_OUT, { availability: "unavailable" }))).toBe(false);
  });

  it("leaves drivers that do not sign in from Ryco yet to their own CLI", () => {
    // The terminal method (Claude, Cursor, Grok, OpenCode) widens this when it lands.
    expect(offer(snapshot("opencode", SIGNED_OUT))).toBe(false);
    expect(offer(snapshot("acpRegistry", SIGNED_OUT))).toBe(false);
  });

  it("offers nothing when this session may not start a sign-in", () => {
    expect(offer(snapshot("codex", SIGNED_OUT), undefined, false)).toBe(false);
  });
});

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
