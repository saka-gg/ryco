import type { UnifiedSettings } from "@ryco/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import { splitUnifiedSettingsPatch, updateMobileSettings } from "./settingsRouting";

describe("settings patch routing", () => {
  it("splits a unified patch into server-owned and client-owned keys", () => {
    const { serverPatch, clientPatch } = splitUnifiedSettingsPatch({
      enableLegacyTokenStreaming: false,
      diffIgnoreWhitespace: true,
    } as Partial<UnifiedSettings>);
    expect(serverPatch).toEqual({ enableLegacyTokenStreaming: false });
    expect(clientPatch).toEqual({ diffIgnoreWhitespace: true });
  });

  it("routes server keys to updateSettings + optimistic apply and client keys to mobileKV", () => {
    const applyServerOptimistic = vi.fn();
    const updateServerSettings = vi.fn();
    const persistClientSettings = vi.fn();

    updateMobileSettings(
      { enableLegacyTokenStreaming: true, diffIgnoreWhitespace: false } as Partial<UnifiedSettings>,
      { applyServerOptimistic, updateServerSettings, persistClientSettings },
    );

    expect(applyServerOptimistic).toHaveBeenCalledWith({ enableLegacyTokenStreaming: true });
    expect(updateServerSettings).toHaveBeenCalledWith({ enableLegacyTokenStreaming: true });
    expect(persistClientSettings).toHaveBeenCalledWith({ diffIgnoreWhitespace: false });
  });

  it("keeps worktree submodule policy node-owned on native", () => {
    const patch = {
      worktreeSubmodules: "top-level" as const,
      projectWorktreeSubmodules: { p: "none" as const },
    };
    expect(splitUnifiedSettingsPatch(patch)).toEqual({ serverPatch: patch, clientPatch: {} });
  });

  it("does not touch the server when only client keys change", () => {
    const applyServerOptimistic = vi.fn();
    const updateServerSettings = vi.fn();
    const persistClientSettings = vi.fn();

    updateMobileSettings({ confirmThreadArchive: false } as Partial<UnifiedSettings>, {
      applyServerOptimistic,
      updateServerSettings,
      persistClientSettings,
    });

    expect(applyServerOptimistic).not.toHaveBeenCalled();
    expect(updateServerSettings).not.toHaveBeenCalled();
    expect(persistClientSettings).toHaveBeenCalledWith({ confirmThreadArchive: false });
  });
});
