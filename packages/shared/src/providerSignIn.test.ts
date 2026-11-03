import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@ryco/contracts";

import {
  canOfferProviderSignIn,
  claudeInstanceSkipsLogin,
  providerNeedsSignIn,
  providerReportsSignIn,
  providerSignInSettled,
} from "./providerSignIn.ts";

type Snapshot = Pick<
  ServerProvider,
  "driver" | "auth" | "enabled" | "installed" | "availability" | "status"
>;

const snapshot = (
  driver: string,
  auth: ServerProvider["auth"],
  patch: Partial<Snapshot> = {},
): Snapshot => ({
  driver: ProviderDriverKind.make(driver),
  auth,
  enabled: true,
  installed: true,
  availability: "available",
  // What Codex reports: an error without a sign-in, ready with one.
  status: auth.status === "authenticated" ? "ready" : "error",
  ...patch,
});

describe("providerReportsSignIn", () => {
  it("takes an authenticated status as a sign-in", () => {
    expect(providerReportsSignIn(snapshot("codex", { status: "authenticated" }))).toBe(true);
    expect(providerReportsSignIn(snapshot("codex", { status: "unauthenticated" }))).toBe(false);
    expect(providerReportsSignIn(snapshot("codex", { status: "unknown" }))).toBe(false);
  });

  it("needs an account for Claude, which reports authenticated whenever it starts", () => {
    expect(providerReportsSignIn(snapshot("claudeAgent", { status: "authenticated" }))).toBe(false);
    expect(
      providerReportsSignIn(
        snapshot("claudeAgent", { status: "authenticated", email: "a@example.com" }),
      ),
    ).toBe(true);
    expect(
      providerReportsSignIn(
        snapshot("claudeAgent", { status: "authenticated", type: "apiKey", label: "API Key" }),
      ),
    ).toBe(true);
  });
});

describe("providerSignInSettled", () => {
  it("settles a reported sign-in, and a ready instance that knows of no account", () => {
    expect(
      providerSignInSettled(
        snapshot("cursor", { status: "authenticated", email: "a@example.com" }),
      ),
    ).toBe(true);
    // Grok never reports its account: once it starts, its login took.
    expect(
      providerSignInSettled(snapshot("grok", { status: "unknown" }, { status: "ready" })),
    ).toBe(true);
    expect(
      providerSignInSettled(snapshot("grok", { status: "unknown" }, { status: "error" })),
    ).toBe(false);
    expect(
      providerSignInSettled(
        snapshot("opencode", { status: "unknown", type: "opencode" }, { status: "warning" }),
      ),
    ).toBe(false);
    expect(
      providerSignInSettled(
        snapshot("claudeAgent", { status: "authenticated" }, { status: "ready" }),
      ),
    ).toBe(false);
  });
});

describe("providerNeedsSignIn", () => {
  it("offers a sign-in for a running Codex instance that reports none", () => {
    expect(providerNeedsSignIn(snapshot("codex", { status: "unauthenticated" }))).toBe(true);
    // Its check failed, so it may well need one.
    expect(providerNeedsSignIn(snapshot("codex", { status: "unknown" }))).toBe(true);
    expect(
      providerNeedsSignIn(snapshot("codex", { status: "authenticated", email: "a@example.com" })),
    ).toBe(false);
  });

  it("offers none for a ready instance that works without an account", () => {
    // A Codex on a custom model provider: ready, with no account it could sign in.
    expect(providerNeedsSignIn(snapshot("codex", { status: "unknown" }, { status: "ready" }))).toBe(
      false,
    );
    expect(
      providerNeedsSignIn(snapshot("codex", { status: "unknown" }, { status: "warning" })),
    ).toBe(true);
  });

  it("offers none for an instance that does not run", () => {
    const signedOut = { status: "unauthenticated" } as const;
    expect(providerNeedsSignIn(snapshot("codex", signedOut, { enabled: false }))).toBe(false);
    expect(providerNeedsSignIn(snapshot("codex", signedOut, { installed: false }))).toBe(false);
    expect(providerNeedsSignIn(snapshot("codex", signedOut, { availability: "unavailable" }))).toBe(
      false,
    );
  });

  it("offers the drivers that sign in in a terminal", () => {
    // Claude reports authenticated whenever it starts; only an account shows its login.
    expect(providerNeedsSignIn(snapshot("claudeAgent", { status: "authenticated" }))).toBe(true);
    expect(
      providerNeedsSignIn(
        snapshot("claudeAgent", { status: "authenticated", email: "a@example.com" }),
      ),
    ).toBe(false);
    expect(providerNeedsSignIn(snapshot("cursor", { status: "unauthenticated" }))).toBe(true);
    expect(providerNeedsSignIn(snapshot("opencode", { status: "unknown" }))).toBe(true);
    expect(providerNeedsSignIn(snapshot("grok", { status: "unknown" }))).toBe(true);
    expect(providerNeedsSignIn(snapshot("grok", { status: "unknown" }, { status: "ready" }))).toBe(
      false,
    );
  });

  it("offers none for a driver the node cannot sign in", () => {
    expect(providerNeedsSignIn(snapshot("acpRegistry", { status: "unauthenticated" }))).toBe(false);
    expect(providerNeedsSignIn(snapshot("copilot", { status: "unauthenticated" }))).toBe(false);
  });
});

function fullSnapshot(
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
  return canOfferProviderSignIn({ provider, instance, capabilityAllowed });
}

const SIGNED_OUT = { status: "unauthenticated" } as const;

describe("canOfferProviderSignIn", () => {
  it("offers Codex while it reports no sign-in", () => {
    expect(offer(fullSnapshot("codex", SIGNED_OUT))).toBe(true);
    expect(offer(fullSnapshot("codex", { status: "unknown" }, { status: "error" }))).toBe(true);
    expect(offer(fullSnapshot("codex", { status: "authenticated", email: "a@example.com" }))).toBe(
      false,
    );
  });

  it("leaves a Codex on a custom model provider alone: it is ready without an account", () => {
    expect(offer(fullSnapshot("codex", { status: "unknown" }))).toBe(false);
  });

  it("offers a Claude instance that started without an account", () => {
    expect(offer(fullSnapshot("claudeAgent", { status: "authenticated" }))).toBe(true);
    expect(
      offer(
        fullSnapshot("claudeAgent", { status: "authenticated" }),
        settings("claudeAgent", ["HOME"]),
      ),
    ).toBe(true);
    expect(
      offer(fullSnapshot("claudeAgent", { status: "authenticated", email: "a@example.com" })),
    ).toBe(false);
    expect(
      offer(
        fullSnapshot("claudeAgent", { status: "authenticated", type: "max", label: "Claude Max" }),
      ),
    ).toBe(false);
  });

  it("never offers a Claude instance whose settings route it past the login", () => {
    const signedOut = fullSnapshot("claudeAgent", { status: "authenticated" });
    expect(offer(signedOut, settings("claudeAgent", ["ANTHROPIC_BASE_URL"]))).toBe(false);
    expect(
      offer(signedOut, settings("claudeAgent", ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"])),
    ).toBe(false);
    expect(offer(signedOut, settings("claudeAgent", ["CLAUDE_CODE_USE_BEDROCK"]))).toBe(false);
  });

  it("offers nothing for an instance that does not run", () => {
    expect(offer(fullSnapshot("codex", SIGNED_OUT, { installed: false }))).toBe(false);
    expect(offer(fullSnapshot("codex", SIGNED_OUT, { enabled: false }))).toBe(false);
    expect(offer(fullSnapshot("codex", SIGNED_OUT, { availability: "unavailable" }))).toBe(false);
  });

  it("offers the drivers that sign in in a terminal, and leaves the rest to their own flow", () => {
    expect(offer(fullSnapshot("opencode", SIGNED_OUT))).toBe(true);
    expect(offer(fullSnapshot("cursor", SIGNED_OUT))).toBe(true);
    // Grok never names its account: one that does not start may need its login.
    expect(offer(fullSnapshot("grok", { status: "unknown" }, { status: "error" }))).toBe(true);
    expect(offer(fullSnapshot("grok", { status: "unknown" }))).toBe(false);
    // ACP Registry keeps its own authentication; Copilot's login is not verified yet.
    expect(offer(fullSnapshot("acpRegistry", SIGNED_OUT))).toBe(false);
    expect(offer(fullSnapshot("copilot", SIGNED_OUT))).toBe(false);
  });

  it("offers nothing when this session may not start a sign-in", () => {
    expect(offer(fullSnapshot("codex", SIGNED_OUT), undefined, false)).toBe(false);
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
