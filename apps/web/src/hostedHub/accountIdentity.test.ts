import type { HostedAccountProfile } from "@ryco/client-runtime/authorization";
import { describe, expect, it } from "vite-plus/test";

import {
  accountIdentity,
  normalizeUsernameInput,
  USERNAME_MAX_LENGTH,
  usernameIssue,
} from "./accountIdentity";

function profile(overrides: Partial<HostedAccountProfile> = {}): HostedAccountProfile {
  return {
    username: "ada",
    usernameNeedsChange: false,
    usernameChangedAt: null,
    usernameChangeAvailableAt: null,
    displayName: "Ada Lovelace",
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("normalizeUsernameInput", () => {
  it("lowercases and drops a leading @", () => {
    expect(normalizeUsernameInput("@Ada_L")).toBe("ada_l");
    expect(normalizeUsernameInput("@@ada")).toBe("ada");
  });

  it("drops every character a username can never contain", () => {
    expect(normalizeUsernameInput("ada.lovelace-1 ü!")).toBe("adalovelace1");
    expect(normalizeUsernameInput("a@b")).toBe("ab");
  });

  it("caps the length at the maximum", () => {
    expect(normalizeUsernameInput("a".repeat(USERNAME_MAX_LENGTH + 10))).toHaveLength(
      USERNAME_MAX_LENGTH,
    );
  });
});

describe("usernameIssue", () => {
  it("accepts a well-formed name", () => {
    expect(usernameIssue("ada")).toBeNull();
    expect(usernameIssue("ada_lovelace_1815")).toBeNull();
    expect(usernameIssue("a".repeat(USERNAME_MAX_LENGTH))).toBeNull();
  });

  it("refuses a name that is too short or too long", () => {
    expect(usernameIssue("")).toBe("Use at least 3 characters.");
    expect(usernameIssue("ad")).toBe("Use at least 3 characters.");
    expect(usernameIssue("a".repeat(USERNAME_MAX_LENGTH + 1))).toBe(
      `Use at most ${USERNAME_MAX_LENGTH} characters.`,
    );
  });

  it("refuses characters outside lowercase letters, digits and underscores", () => {
    expect(usernameIssue("Ada")).toBe("Use lowercase letters, numbers and underscores.");
    expect(usernameIssue("ada-l")).toBe("Use lowercase letters, numbers and underscores.");
  });

  it("refuses the machine-assigned legacy_ prefix", () => {
    expect(usernameIssue("legacy_ada")).toBe("Pick a name that does not start with legacy_.");
  });
});

describe("accountIdentity", () => {
  it("names an account with a chosen username by its handle", () => {
    expect(accountIdentity(profile(), "Ada Lovelace")).toEqual({
      handle: "@ada",
      initial: "A",
      needsUsername: false,
    });
  });

  it("falls back to the display name while the username still needs changing", () => {
    expect(
      accountIdentity(profile({ username: "grace", usernameNeedsChange: true }), "Grace Hopper"),
    ).toEqual({ handle: "Grace Hopper", initial: "G", needsUsername: true });
  });

  it("never presents a machine-assigned legacy_ name as the handle", () => {
    expect(
      accountIdentity(
        profile({ username: "legacy_abcdefgh234", usernameNeedsChange: false }),
        "Ada Lovelace",
      ),
    ).toEqual({ handle: "Ada Lovelace", initial: "A", needsUsername: true });
  });

  it("uses the display name without asking for a username when there is no profile", () => {
    expect(accountIdentity(null, "Ada Lovelace")).toEqual({
      handle: "Ada Lovelace",
      initial: "A",
      needsUsername: false,
    });
  });

  it("has a neutral label and initial when nothing names the account", () => {
    expect(accountIdentity(null, null)).toEqual({
      handle: "Account",
      initial: "?",
      needsUsername: false,
    });
  });
});
