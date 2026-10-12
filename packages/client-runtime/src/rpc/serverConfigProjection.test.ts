import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderStatusUpdate,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyProviderStatusesDelta } from "./serverConfigProjection.ts";

const model = (slug: string) => ({ slug, name: slug, isCustom: false, capabilities: null });
const provider = (instanceId: string, overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-12T00:00:00.000Z",
  models: [model("a")],
  slashCommands: [],
  skills: [],
  ...overrides,
});
const statusOf = (entry: ServerProvider): ServerProviderStatusUpdate => {
  const { models: _models, skills: _skills, slashCommands: _slashCommands, ...status } = entry;
  return status;
};

describe("applyProviderStatusesDelta", () => {
  it("keeps untouched instances and the catalogs a delta leaves out", () => {
    const one = provider("one");
    const two = provider("two");
    const next = applyProviderStatusesDelta([one, two], {
      instanceIds: ["one", "two"] as never,
      providers: [{ ...statusOf(two), status: "error" }],
    });
    expect(next?.[0]).toBe(one);
    expect(next?.[1]).toEqual({ ...two, status: "error" });
  });

  it("takes a catalog the delta carries", () => {
    const next = applyProviderStatusesDelta([provider("one")], {
      instanceIds: ["one"] as never,
      providers: [{ ...statusOf(provider("one")), models: [model("b")] }],
    });
    expect(next?.[0]?.models.map((entry) => entry.slug)).toEqual(["b"]);
  });

  it("drops instances the id list no longer names and follows its order", () => {
    const next = applyProviderStatusesDelta([provider("one"), provider("two"), provider("three")], {
      instanceIds: ["three", "one"] as never,
      providers: [],
    });
    expect(next?.map((entry) => entry.instanceId)).toEqual(["three", "one"]);
  });

  it("refuses a delta that does not fit the list it is applied to", () => {
    // An instance this list never had, without its catalogs.
    expect(
      applyProviderStatusesDelta([provider("one")], {
        instanceIds: ["one", "new"] as never,
        providers: [statusOf(provider("new"))],
      }),
    ).toBeNull();
    expect(
      applyProviderStatusesDelta([provider("one")], {
        instanceIds: ["ghost"] as never,
        providers: [],
      }),
    ).toBeNull();
  });
});
