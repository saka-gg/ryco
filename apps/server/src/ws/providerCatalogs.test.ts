import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
} from "@ryco/contracts";

import { omitKnownProviderCatalogs, providerCatalogDigest } from "./providerCatalogs.ts";

const model = (slug: string) => ({ slug, name: slug, isCustom: false, capabilities: null });
const provider = (instanceId: string, slug: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-12T00:00:00.000Z",
  models: [model(slug)],
  skills: [],
  slashCommands: [],
});
const config = (providers: ReadonlyArray<ServerProvider>) =>
  ({
    environment: { environmentId: EnvironmentId.make("environment-local") },
    providers,
    settings: DEFAULT_SERVER_SETTINGS,
  }) as unknown as ServerConfig;

describe("provider catalogs", () => {
  it("digests catalogs by content alone", () => {
    const one = provider("one", "a");
    assert.equal(providerCatalogDigest(one), providerCatalogDigest(provider("two", "a")));
    assert.equal(
      providerCatalogDigest(one),
      providerCatalogDigest({ ...one, status: "error", checkedAt: "2026-10-13T00:00:00.000Z" }),
    );
    assert.notEqual(providerCatalogDigest(one), providerCatalogDigest(provider("one", "b")));
  });

  it("leaves out only the catalogs the client named and reports every digest", () => {
    const codex = provider("codex", "a");
    const claude = provider("claude", "b");
    const result = omitKnownProviderCatalogs(config([codex, claude]), [
      providerCatalogDigest(codex),
      "digest-the-server-never-made",
    ]);
    assert.deepEqual(result.providerCatalogs.omitted.map(String), ["codex"]);
    assert.deepEqual(Object.keys(result.providerCatalogs.digests).toSorted(), ["claude", "codex"]);
    assert.deepEqual(result.config.providers[0]?.models, []);
    assert.deepEqual(result.config.providers[1], claude);
  });

  it("returns the config itself when nothing is left out", () => {
    const input = config([provider("codex", "a")]);
    assert.strictEqual(omitKnownProviderCatalogs(input, []).config, input);
  });
});
