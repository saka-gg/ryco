import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { stabilizeProviderStatusesSnapshot } from "./ChatView.providerStatuses";

function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-14T09:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("stabilizeProviderStatusesSnapshot", () => {
  it("keeps the cached snapshot while the content is the same", () => {
    const cache = { key: "", snapshot: [] as ServerProvider[] };
    const first = stabilizeProviderStatusesSnapshot([provider()], cache);
    const second = stabilizeProviderStatusesSnapshot([provider()], cache);
    expect(second).toBe(first);
  });

  it("takes the new snapshot when what the composer reads changes", () => {
    const cache = { key: "", snapshot: [] as ServerProvider[] };
    const first = stabilizeProviderStatusesSnapshot([provider()], cache);
    const next = [provider({ checkedAt: "2026-11-14T09:05:00.000Z" })];
    expect(stabilizeProviderStatusesSnapshot(next, cache)).toBe(next);
    expect(stabilizeProviderStatusesSnapshot(next, cache)).not.toBe(first);
  });
});
