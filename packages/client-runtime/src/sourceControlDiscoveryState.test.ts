import { assert, beforeEach, it } from "vite-plus/test";
import type { SourceControlDiscoveryResult } from "@ryco/contracts";
import { AtomRegistry } from "effect/reactivity";

import {
  EMPTY_SOURCE_CONTROL_DISCOVERY_STATE,
  createSourceControlDiscoveryManager,
} from "./sourceControlDiscoveryState.ts";

const EMPTY_RESULT: SourceControlDiscoveryResult = {
  versionControlSystems: [],
  sourceControlProviders: [],
};

function unresolvedDiscovery() {
  throw new Error("Discovery resolver was not initialized.");
}

let registry = AtomRegistry.make();

beforeEach(() => {
  registry.dispose();
  registry = AtomRegistry.make();
});

it("stores refreshed discovery data in an atom snapshot", async () => {
  const manager = createSourceControlDiscoveryManager({
    getRegistry: () => registry,
    getClient: () => ({
      discoverSourceControl: async () => EMPTY_RESULT,
    }),
  });

  assert.deepStrictEqual(manager.getSnapshot({ key: null }), EMPTY_SOURCE_CONTROL_DISCOVERY_STATE);

  const result = await manager.refresh({ key: "primary" });

  assert.strictEqual(result, EMPTY_RESULT);
  assert.deepStrictEqual(manager.getSnapshot({ key: "primary" }), {
    data: EMPTY_RESULT,
    error: null,
    isPending: false,
  });
});

it("deduplicates in-flight discovery refreshes by target key", async () => {
  let resolveDiscovery: (result: SourceControlDiscoveryResult) => void = unresolvedDiscovery;
  let calls = 0;
  const manager = createSourceControlDiscoveryManager({
    getRegistry: () => registry,
    getClient: () => ({
      discoverSourceControl: () => {
        calls += 1;
        return new Promise<SourceControlDiscoveryResult>((resolve) => {
          resolveDiscovery = resolve;
        });
      },
    }),
  });

  const first = manager.refresh({ key: "primary" });
  const second = manager.refresh({ key: "primary" });

  assert.strictEqual(first, second);
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(manager.getSnapshot({ key: "primary" }), {
    data: null,
    error: null,
    isPending: true,
  });

  resolveDiscovery(EMPTY_RESULT);
  await first;

  assert.deepStrictEqual(manager.getSnapshot({ key: "primary" }), {
    data: EMPTY_RESULT,
    error: null,
    isPending: false,
  });
});

it("keeps the previous snapshot when refresh fails", async () => {
  let shouldFail = false;
  const manager = createSourceControlDiscoveryManager({
    getRegistry: () => registry,
    getClient: () => ({
      discoverSourceControl: async () => {
        if (shouldFail) {
          throw new Error("probe failed");
        }
        return EMPTY_RESULT;
      },
    }),
  });

  await manager.refresh({ key: "primary" });
  shouldFail = true;

  const result = await manager.refresh({ key: "primary" });

  assert.strictEqual(result, EMPTY_RESULT);
  assert.deepStrictEqual(manager.getSnapshot({ key: "primary" }), {
    data: EMPTY_RESULT,
    error: "probe failed",
    isPending: false,
  });
});

it("asks for the cached result on background revalidation and a fresh probe on explicit refresh", async () => {
  const inputs: Array<{ readonly cached?: boolean } | undefined> = [];
  const pending: Array<(result: SourceControlDiscoveryResult) => void> = [];
  const manager = createSourceControlDiscoveryManager({
    getRegistry: () => registry,
    getClient: () => ({
      discoverSourceControl: (input) => {
        inputs.push(input);
        return new Promise<SourceControlDiscoveryResult>((resolve) => {
          pending.push(resolve);
        });
      },
    }),
  });

  const background = manager.refresh({ key: "primary" }, undefined, { cached: true });
  // The user's explicit refresh does not settle for the cached answer in flight.
  const explicit = manager.refresh({ key: "primary" });
  // Another background revalidation joins the fresh probe.
  const laterBackground = manager.refresh({ key: "primary" }, undefined, { cached: true });

  assert.deepStrictEqual(inputs, [{ cached: true }, undefined]);
  assert.strictEqual(laterBackground, explicit);
  assert.notStrictEqual(background, explicit);

  // The fresh probe answers first; the older cached answer landing later must
  // not replace it.
  const fresh: SourceControlDiscoveryResult = {
    versionControlSystems: [],
    sourceControlProviders: [],
  };
  pending[1]!(fresh);
  await explicit;
  pending[0]!(EMPTY_RESULT);
  await background;
  assert.strictEqual(manager.getSnapshot({ key: "primary" }).data, fresh);
  assert.strictEqual(manager.getSnapshot({ key: "primary" }).isPending, false);
});
