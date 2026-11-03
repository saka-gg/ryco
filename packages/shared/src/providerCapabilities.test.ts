import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@ryco/contracts";

import {
  isBlockingProviderCompatibilityStatus,
  isProviderDefinitelyUnusable,
  isProviderKnownUnusable,
  isProviderReady,
  providerSupportsGeneralFileAttachments,
} from "./providerCapabilities.ts";

describe("providerSupportsGeneralFileAttachments", () => {
  it("accepts general file attachments for every driver", () => {
    for (const driver of [
      "copilot",
      "opencode",
      "codex",
      "claudeAgent",
      "cursor",
      "grok",
    ] as const) {
      expect(providerSupportsGeneralFileAttachments(ProviderDriverKind.make(driver))).toBe(true);
    }
  });
});

describe("isBlockingProviderCompatibilityStatus", () => {
  it("blocks only unsupported and broken ratings", () => {
    expect(isBlockingProviderCompatibilityStatus("unsupported")).toBe(true);
    expect(isBlockingProviderCompatibilityStatus("broken")).toBe(true);
    expect(isBlockingProviderCompatibilityStatus("unknown")).toBe(false);
    expect(isBlockingProviderCompatibilityStatus("supported")).toBe(false);
    expect(isBlockingProviderCompatibilityStatus("graceful")).toBe(false);
    expect(isBlockingProviderCompatibilityStatus(null)).toBe(false);
    expect(isBlockingProviderCompatibilityStatus(undefined)).toBe(false);
  });
});

describe("provider readiness", () => {
  const ready = {
    enabled: true,
    status: "ready",
    availability: "available",
    auth: { status: "authenticated" },
  } as const;

  it("counts signed-out, failing, disabled and unavailable providers as unusable", () => {
    for (const provider of [
      { ...ready, status: "error" as const, auth: { status: "unauthenticated" as const } },
      { ...ready, auth: { status: "unauthenticated" as const } },
      { ...ready, status: "error" as const },
      { ...ready, status: "disabled" as const },
      { ...ready, enabled: false },
      { ...ready, availability: "unavailable" as const },
    ]) {
      expect(isProviderKnownUnusable(provider)).toBe(true);
      expect(isProviderReady(provider)).toBe(false);
    }
  });

  it("does not count a provider still waiting for its first probe", () => {
    const pending = { ...ready, status: "warning" as const, auth: { status: "unknown" as const } };
    expect(isProviderKnownUnusable(pending)).toBe(false);
    expect(isProviderReady(pending)).toBe(false);
    expect(isProviderKnownUnusable({ ...ready, availability: undefined })).toBe(false);
    expect(isProviderReady(ready)).toBe(true);
  });

  it("counts only a state the user has to fix as definitely unusable", () => {
    const installed = { ...ready, installed: true };
    for (const provider of [
      { ...installed, status: "error" as const, auth: { status: "unauthenticated" as const } },
      { ...installed, status: "error" as const, installed: false },
      { ...installed, status: "disabled" as const },
      { ...installed, enabled: false },
      { ...installed, availability: "unavailable" as const },
    ]) {
      expect(isProviderDefinitelyUnusable(provider)).toBe(true);
    }
    // A probe that failed or timed out, with sign-in unknown, may pass next time.
    const probeFailed = {
      ...installed,
      status: "error" as const,
      auth: { status: "unknown" as const },
    };
    expect(isProviderKnownUnusable(probeFailed)).toBe(true);
    expect(isProviderDefinitelyUnusable(probeFailed)).toBe(false);
    expect(
      isProviderDefinitelyUnusable({
        ...installed,
        installed: false,
        status: "warning",
        auth: { status: "unknown" },
      }),
    ).toBe(false);
    expect(isProviderDefinitelyUnusable(installed)).toBe(false);
  });
});
