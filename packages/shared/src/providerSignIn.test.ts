import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ServerProvider } from "@ryco/contracts";

import { providerNeedsSignIn, providerReportsSignIn } from "./providerSignIn.ts";

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

  it("offers none for a driver the node cannot sign in yet", () => {
    expect(providerNeedsSignIn(snapshot("claudeAgent", { status: "authenticated" }))).toBe(false);
    expect(providerNeedsSignIn(snapshot("cursor", { status: "unauthenticated" }))).toBe(false);
    expect(providerNeedsSignIn(snapshot("acpRegistry", { status: "unauthenticated" }))).toBe(false);
  });
});
