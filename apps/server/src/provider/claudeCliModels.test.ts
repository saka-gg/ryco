import { assert, describe, it } from "@effect/vitest";
import type { ServerProviderModel } from "@ryco/contracts";
import { Effect } from "effect";

import { BUNDLED_CLAUDE_MODEL_CATALOG, type ClaudeModelCatalog } from "./ClaudeModelCatalog.ts";
import {
  applyClaudeCliModelInfo,
  type ClaudeCliModelInfo,
  makeClaudeCliModelMemory,
  parseClaudeCliModels,
} from "./claudeCliModels.ts";

const catalog = BUNDLED_CLAUDE_MODEL_CATALOG;
const manifestModels = catalog.models.map((entry) => entry.model);

function modelBySlug(models: ReadonlyArray<ServerProviderModel>, slug: string) {
  const model = models.find((candidate) => candidate.slug === slug);
  if (!model) assert.fail(`Expected ${slug} in the model list.`);
  return model;
}

function effortOf(model: ServerProviderModel) {
  const descriptor = model.capabilities?.optionDescriptors?.find(
    (candidate) => candidate.id === "effort",
  );
  return descriptor?.type === "select" ? descriptor : undefined;
}

function effortIds(model: ServerProviderModel) {
  return effortOf(model)?.options.map((option) => option.id);
}

function defaultEffort(model: ServerProviderModel) {
  return effortOf(model)?.options.find((option) => option.isDefault)?.id;
}

function hasFastMode(model: ServerProviderModel) {
  return (
    model.capabilities?.optionDescriptors?.some(
      (descriptor) => descriptor.type === "boolean" && descriptor.id === "fastMode",
    ) ?? false
  );
}

/** A one-model catalog with a prompt-injected `ultrathink` option and the given effort options. */
function catalogWithEffort(
  options: ReadonlyArray<{ readonly id: string; readonly isDefault?: boolean }>,
): { readonly catalog: ClaudeModelCatalog; readonly model: ServerProviderModel } {
  const model: ServerProviderModel = {
    slug: "claude-test-1",
    name: "Claude Test 1",
    aliases: ["test"],
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select",
          options: options.map((option) => ({ label: option.id, ...option })),
          promptInjectedValues: ["ultrathink"],
        },
      ],
    },
  };
  return {
    catalog: {
      models: [
        {
          model,
          runtime: { effortMap: { ultracode: "xhigh", ultrathink: null } },
          compatibility: {},
        },
      ],
    },
    model,
  };
}

describe("parseClaudeCliModels", () => {
  it("returns no CLI data for a missing, non-array or empty report", () => {
    for (const raw of [undefined, null, "models", { value: "opus" }, [], [null, 1, "opus"]]) {
      assert.strictEqual(parseClaudeCliModels(raw), undefined);
    }
  });

  it("drops malformed rows and keeps the valid ones", () => {
    const parsed = parseClaudeCliModels([
      { value: "x".repeat(129), supportsAutoMode: true },
      { value: "   " },
      { value: 7 },
      { value: "opus", resolvedModel: 12 },
      { value: "opus", supportsAutoMode: "yes" },
      { value: "opus", supportedEffortLevels: "high" },
      ["opus"],
      {
        value: " claude-opus-4-8 ",
        displayName: "Opus 4.8",
        supportsAutoMode: false,
        supportedEffortLevels: ["high", "turbo", "low", "high"],
      },
      { value: "sonnet", supportedEffortLevels: ["turbo"], supportsFastMode: true },
    ]);
    assert.deepStrictEqual(parsed, [
      { value: "claude-opus-4-8", supportsAutoMode: false, supportedEffortLevels: ["low", "high"] },
      { value: "sonnet", supportsFastMode: true },
    ]);
  });

  it("reads at most 64 rows", () => {
    const rows = Array.from({ length: 80 }, (_, index) => ({ value: `model-${index}` }));
    assert.strictEqual(parseClaudeCliModels(rows)?.length, 64);
  });
});

describe("applyClaudeCliModelInfo", () => {
  const apply = (cli: ReadonlyArray<ClaudeCliModelInfo>) =>
    applyClaudeCliModelInfo(manifestModels, cli, catalog);

  it("matches an alias row through its resolved model", () => {
    const models = apply([
      { value: "opus", resolvedModel: "claude-opus-4-8", supportsAutoMode: false },
    ]);
    assert.strictEqual(modelBySlug(models, "claude-opus-4-8").supportsAutoMode, false);
    assert.strictEqual(modelBySlug(models, "claude-opus-5-5").supportsAutoMode, undefined);
  });

  it("leaves the manifest's alias model alone when the CLI's alias resolves to another", () => {
    // The CLI's `opus` has moved on to a newer Opus than the manifest's `opus` (Opus 4.8).
    const models = apply([
      {
        value: "opus",
        resolvedModel: "claude-opus-5-5",
        supportsAutoMode: false,
        supportsFastMode: false,
        supportedEffortLevels: ["low"],
      },
    ]);
    assert.strictEqual(
      modelBySlug(models, "claude-opus-4-8"),
      modelBySlug(manifestModels, "claude-opus-4-8"),
    );
    const opus55 = modelBySlug(models, "claude-opus-5-5");
    assert.strictEqual(opus55.supportsAutoMode, false);
    assert.isFalse(hasFastMode(opus55));
  });

  it("ignores an alias a proxy remaps to a model outside the manifest", () => {
    // A CLIProxyAPI instance with ANTHROPIC_DEFAULT_SONNET_MODEL pointing elsewhere.
    const models = apply([
      { value: "sonnet", resolvedModel: "gpt-5.5", supportsAutoMode: false },
      { value: "sonnet[1m]", resolvedModel: "gpt-5.5[1m]", supportsFastMode: false },
    ]);
    models.forEach((model, index) => assert.strictEqual(model, manifestModels[index]));
  });

  it("matches a resolved model through one of the model's aliases", () => {
    const models = apply([
      { value: "opus", resolvedModel: "claude-opus-4-6-20251117", supportsAutoMode: false },
    ]);
    assert.strictEqual(modelBySlug(models, "claude-opus-4-6").supportsAutoMode, false);
    assert.strictEqual(modelBySlug(models, "claude-opus-4-8").supportsAutoMode, undefined);
  });

  it("matches a row whose value is the slug Ryco sends, whatever it resolves to", () => {
    const models = apply([
      {
        value: "claude-opus-4-5",
        resolvedModel: "claude-opus-4-5-20251101",
        supportsAutoMode: false,
      },
    ]);
    assert.strictEqual(modelBySlug(models, "claude-opus-4-5").supportsAutoMode, false);
  });

  it("matches a row naming one of the model's aliases", () => {
    const models = apply([{ value: "Sonnet", supportsAutoMode: true }]);
    assert.strictEqual(modelBySlug(models, "claude-sonnet-5").supportsAutoMode, true);
  });

  it("strips the context-window suffix from row identifiers", () => {
    const models = apply([{ value: "claude-opus-5-5[1m]", supportsAutoMode: false }]);
    assert.strictEqual(modelBySlug(models, "claude-opus-5-5").supportsAutoMode, false);
  });

  it("skips release-dependent aliases that name no model", () => {
    const models = apply([
      { value: "default", supportsAutoMode: false, supportsFastMode: false },
      { value: "opusplan", supportsAutoMode: false },
      { value: "best[1m]", supportsAutoMode: false },
    ]);
    models.forEach((model, index) => assert.strictEqual(model, manifestModels[index]));
  });

  it("reads a release-dependent alias that says which model it resolves to", () => {
    const models = apply([
      { value: "default", resolvedModel: "claude-opus-5-5", supportsAutoMode: false },
    ]);
    assert.strictEqual(modelBySlug(models, "claude-opus-5-5").supportsAutoMode, false);
  });

  it("leaves a flag unknown when the matching rows disagree", () => {
    const models = apply([
      { value: "claude-opus-5-5", supportsAutoMode: true, supportsFastMode: false },
      { value: "claude-opus-5-5[1m]", supportsAutoMode: false },
    ]);
    const opus = modelBySlug(models, "claude-opus-5-5");
    assert.strictEqual(opus.supportsAutoMode, undefined);
    assert.isTrue(hasFastMode(opus));
  });

  it("prefers rows naming the slug over rows naming an alias", () => {
    const models = apply([
      { value: "opus", supportsAutoMode: false },
      { value: "claude-opus-4-8", supportsAutoMode: true },
    ]);
    assert.strictEqual(modelBySlug(models, "claude-opus-4-8").supportsAutoMode, true);
  });

  it("keeps ultracode only when xhigh is offered, and always keeps prompt-injected efforts", () => {
    const { catalog: testCatalog, model } = catalogWithEffort([
      { id: "low" },
      { id: "medium" },
      { id: "high", isDefault: true },
      { id: "xhigh" },
      { id: "max" },
      { id: "ultracode" },
      { id: "ultrathink" },
    ]);
    const [withoutXhigh] = applyClaudeCliModelInfo(
      [model],
      [{ value: "claude-test-1", supportedEffortLevels: ["low", "medium", "high"] }],
      testCatalog,
    );
    assert.deepStrictEqual(effortIds(withoutXhigh!), ["low", "medium", "high", "ultrathink"]);
    assert.deepStrictEqual(effortOf(withoutXhigh!)?.promptInjectedValues, ["ultrathink"]);

    const [withXhigh] = applyClaudeCliModelInfo(
      [model],
      [{ value: "claude-test-1", supportedEffortLevels: ["low", "medium", "high", "xhigh"] }],
      testCatalog,
    );
    assert.deepStrictEqual(effortIds(withXhigh!), [
      "low",
      "medium",
      "high",
      "xhigh",
      "ultracode",
      "ultrathink",
    ]);
  });

  it("keeps the manifest's own effort remapping when narrowing", () => {
    // Sonnet 4.6 sends `max` as `high`, so a CLI without `max` keeps the option.
    const models = apply([
      { value: "claude-sonnet-4-6", supportedEffortLevels: ["low", "medium", "high"] },
    ]);
    assert.deepStrictEqual(effortIds(modelBySlug(models, "claude-sonnet-4-6")), [
      "low",
      "medium",
      "high",
      "max",
    ]);
  });

  it("moves a dropped default to the highest remaining option below it", () => {
    const models = apply([
      { value: "claude-opus-4-7", supportedEffortLevels: ["low", "medium", "high", "max"] },
    ]);
    const opus47 = modelBySlug(models, "claude-opus-4-7");
    assert.deepStrictEqual(effortIds(opus47), ["low", "medium", "high", "max"]);
    assert.strictEqual(defaultEffort(opus47), "high");
    assert.strictEqual(effortOf(opus47)?.options.filter((option) => option.isDefault).length, 1);
  });

  it("moves a dropped default to the first remaining option when none ranks below it", () => {
    const { catalog: testCatalog, model } = catalogWithEffort([
      { id: "low", isDefault: true },
      { id: "high" },
      { id: "max" },
    ]);
    const [narrowed] = applyClaudeCliModelInfo(
      [model],
      [{ value: "test", supportedEffortLevels: ["high", "max"] }],
      testCatalog,
    );
    assert.deepStrictEqual(effortIds(narrowed!), ["high", "max"]);
    assert.strictEqual(defaultEffort(narrowed!), "high");
  });

  it("leaves the effort descriptor untouched when no offered option would remain", () => {
    const { catalog: testCatalog, model } = catalogWithEffort([
      { id: "high", isDefault: true },
      { id: "max" },
      { id: "ultrathink" },
    ]);
    const [unchanged] = applyClaudeCliModelInfo(
      [model],
      [{ value: "claude-test-1", supportedEffortLevels: ["low"] }],
      testCatalog,
    );
    assert.strictEqual(unchanged, model);

    // Rows for one model offering disjoint levels intersect to nothing.
    const models = apply([
      { value: "claude-opus-5-5", supportedEffortLevels: ["low"] },
      { value: "claude-opus-5-5[1m]", supportedEffortLevels: ["max"] },
    ]);
    assert.strictEqual(
      modelBySlug(models, "claude-opus-5-5"),
      modelBySlug(manifestModels, "claude-opus-5-5"),
    );
  });

  it("intersects the effort levels of every matching row", () => {
    const models = apply([
      { value: "claude-opus-4-6", supportedEffortLevels: ["low", "medium", "high", "max"] },
      { value: "claude-opus-4-6[1m]", supportedEffortLevels: ["low", "medium", "high"] },
    ]);
    assert.deepStrictEqual(effortIds(modelBySlug(models, "claude-opus-4-6")), [
      "low",
      "medium",
      "high",
    ]);
  });

  it("never changes custom models", () => {
    const custom: ServerProviderModel = {
      slug: "claude-opus-5-5-proxy",
      name: "claude-opus-5-5-proxy",
      isCustom: true,
      capabilities: { optionDescriptors: [] },
    };
    const [result] = applyClaudeCliModelInfo(
      [custom],
      [{ value: "claude-opus-5-5-proxy", supportsAutoMode: false }],
      catalog,
    );
    assert.strictEqual(result, custom);
  });

  it("removes the Fast toggle where the CLI says Fast mode is unsupported, and never adds one", () => {
    const models = apply([
      { value: "claude-opus-5-5", supportsFastMode: false },
      { value: "claude-sonnet-5", supportsFastMode: true },
    ]);
    assert.isFalse(hasFastMode(modelBySlug(models, "claude-opus-5-5")));
    assert.isTrue(hasFastMode(modelBySlug(models, "claude-opus-5")));
    assert.isFalse(hasFastMode(modelBySlug(models, "claude-sonnet-5")));
    // The other descriptors stay as they were.
    assert.deepStrictEqual(
      effortOf(modelBySlug(models, "claude-opus-5-5")),
      effortOf(modelBySlug(manifestModels, "claude-opus-5-5")),
    );
  });
});

describe("makeClaudeCliModelMemory", () => {
  const report: ReadonlyArray<ClaudeCliModelInfo> = [{ value: "opus", supportsAutoMode: false }];

  it.effect("recalls the report of the same CLI version", () =>
    Effect.gen(function* () {
      const memory = yield* makeClaudeCliModelMemory();
      assert.strictEqual(yield* memory.recall("2.1.300"), undefined);
      yield* memory.remember("2.1.300", report);
      assert.strictEqual(yield* memory.recall("2.1.300"), report);
      assert.strictEqual(yield* memory.recall("2.1.300"), report);
    }),
  );

  it.effect("drops the report once another CLI version is probed", () =>
    Effect.gen(function* () {
      const memory = yield* makeClaudeCliModelMemory();
      yield* memory.remember("2.1.300", report);
      assert.strictEqual(yield* memory.recall("2.1.301"), undefined);
      assert.strictEqual(yield* memory.recall("2.1.300"), undefined);
    }),
  );

  it.effect("keeps nothing for an unparsed CLI version", () =>
    Effect.gen(function* () {
      const memory = yield* makeClaudeCliModelMemory();
      yield* memory.remember(null, report);
      assert.strictEqual(yield* memory.recall(null), undefined);
    }),
  );
});
