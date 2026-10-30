import { ProviderDriverKind, ProviderInstanceId, type SessionImportStore } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveSessionImportContinuation,
  sessionImportContinuationProviders,
  type SessionImportContinuationProvider,
} from "./continuation.ts";

const model = (slug: string, isDefault = false) => ({
  slug,
  name: slug,
  isDefault,
  isCustom: false,
  capabilities: null,
});
const provider = (
  instanceId: string,
  overrides: Partial<SessionImportContinuationProvider> = {},
): SessionImportContinuationProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  models: [model("first"), model("default", true)],
  ...overrides,
});
const store = (instanceIds: string[]): SessionImportStore => ({
  key: "a".repeat(64),
  label: "Default store",
  isDefault: true,
  instanceIds: instanceIds.map((id) => ProviderInstanceId.make(id)),
});

describe("session import continuation", () => {
  it("offers only usable instances of the source's driver that use the chosen store", () => {
    const providers = [
      provider("codex"),
      provider("other-store"),
      provider("disabled", { enabled: false }),
      provider("missing", { installed: false }),
      provider("broken", { availability: "unavailable" }),
      provider("claude", { driver: ProviderDriverKind.make("claudeAgent") }),
    ];
    const ids = (source: "codex" | "claudeAgent") =>
      sessionImportContinuationProviders(
        providers,
        source,
        store(["codex", "disabled", "missing", "broken", "claude"]),
      ).map((entry) => entry.instanceId);

    expect(ids("codex")).toEqual(["codex"]);
    expect(ids("claudeAgent")).toEqual(["claude"]);
    expect(sessionImportContinuationProviders(providers, "codex", undefined)).toEqual([]);
  });

  it("keeps a still-offered choice and otherwise falls back to the first instance's default model", () => {
    const providers = [provider("one"), provider("two", { models: [model("only")] })];

    expect(
      resolveSessionImportContinuation(providers, { instanceId: "two", model: "only" }),
    ).toMatchObject({ provider: { instanceId: "two" }, model: { slug: "only" } });
    expect(
      resolveSessionImportContinuation(providers, { instanceId: "gone", model: "gone" }),
    ).toMatchObject({ provider: { instanceId: "one" }, model: { slug: "default" } });
    expect(resolveSessionImportContinuation([], { instanceId: "", model: "" })).toEqual({
      provider: undefined,
      model: undefined,
    });
  });
});
