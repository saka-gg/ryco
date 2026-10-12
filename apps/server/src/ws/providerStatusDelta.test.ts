import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@ryco/contracts";

import { makeProviderStatusDeltaTracker } from "./providerStatusDelta.ts";

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
  models: [model("a"), model("b")],
  slashCommands: [],
  skills: [],
  ...overrides,
});

describe("makeProviderStatusDeltaTracker", () => {
  it("sends nothing when a fresh list equals what was sent", () => {
    const tracker = makeProviderStatusDeltaTracker([provider("one"), provider("two")]);
    // New objects, same content: the registry rebuilt the list.
    assert.isNull(tracker.next([provider("one"), provider("two")]));
  });

  it("sends a changed status without its unchanged catalogs", () => {
    const tracker = makeProviderStatusDeltaTracker([provider("one"), provider("two")]);
    const payload = tracker.next([provider("one"), provider("two", { status: "error" })]);
    assert.deepEqual(payload?.instanceIds.map(String), ["one", "two"]);
    assert.equal(payload?.providers.length, 1);
    const [update] = payload!.providers;
    assert.equal(update?.status, "error");
    assert.isFalse("models" in update!);
    assert.isFalse("skills" in update!);
    assert.isFalse("slashCommands" in update!);
  });

  it("sends only the catalog that changed", () => {
    const tracker = makeProviderStatusDeltaTracker([provider("one")]);
    const payload = tracker.next([provider("one", { models: [model("a"), model("c")] })]);
    const [update] = payload!.providers;
    assert.deepEqual(
      update?.models?.map((entry) => entry.slug),
      ["a", "c"],
    );
    assert.isFalse("skills" in update!);
  });

  it("sends a new instance whole and reports removals and reordering through the id list", () => {
    const tracker = makeProviderStatusDeltaTracker([provider("one"), provider("two")]);
    const added = tracker.next([provider("two"), provider("three")]);
    assert.deepEqual(added?.instanceIds.map(String), ["two", "three"]);
    assert.deepEqual(
      added?.providers.map((entry) => [String(entry.instanceId), entry.models?.length]),
      [["three", 2]],
    );
    const reordered = tracker.next([provider("three"), provider("two")]);
    assert.deepEqual(reordered?.instanceIds.map(String), ["three", "two"]);
    assert.deepEqual(reordered?.providers, []);
  });

  it("measures each change against what this tracker sent last, not the first list", () => {
    const tracker = makeProviderStatusDeltaTracker([provider("one")]);
    tracker.next([provider("one", { status: "error" })]);
    assert.isNull(tracker.next([provider("one", { status: "error" })]));
    const back = tracker.next([provider("one")]);
    assert.equal(back?.providers[0]?.status, "ready");
  });
});
