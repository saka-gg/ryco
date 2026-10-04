import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@ryco/contracts";

import {
  isBlockingProviderCompatibilityStatus,
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
