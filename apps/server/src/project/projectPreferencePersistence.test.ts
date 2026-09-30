import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { ProviderInstanceId, ServerSettings } from "@ryco/contracts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsLive, ServerSettingsService } from "../serverSettings.ts";

const layer = () =>
  ServerSettingsLive.pipe(
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), { prefix: "fixture-preference-persistence-" }),
      ),
    ),
  );
it.layer(NodeServices.layer)("project preference persistence", (it) => {
  it.effect(
    "serializes independent concurrent writes and rejects conflicts without changing disk",
    () =>
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        yield* Effect.all(
          [
            settings.updateSettings({
              projectPreferences: { a: { worktreeBranchPrefix: "team" } },
              expectedProjectPreferences: { a: { worktreeBranchPrefix: null } },
            }),
            settings.updateSettings({
              projectPreferences: {
                a: { runSetupScript: false },
                b: { defaultThreadEnvMode: "worktree" },
              },
              expectedProjectPreferences: { a: { runSetupScript: null } },
            }),
          ],
          { concurrency: 2 },
        );
        assert.deepEqual((yield* settings.getSettings).projectPreferences, {
          a: { worktreeBranchPrefix: "team", runSetupScript: false },
          b: { defaultThreadEnvMode: "worktree" },
        });
        const fs = yield* FileSystem.FileSystem;
        const { settingsPath } = yield* ServerConfig;
        const before = yield* fs.readFileString(settingsPath);
        const conflict = yield* settings
          .updateSettings({
            projectPreferences: { a: { runSetupScript: true } },
            expectedProjectPreferences: { a: { runSetupScript: null } },
          })
          .pipe(Effect.result);
        assert.equal(conflict._tag, "Failure");
        assert.equal(yield* fs.readFileString(settingsPath), before);
        yield* settings.updateSettings({
          projectPreferences: { a: { runSetupScript: null, initialModelSelection: null } },
        });
        const saved = Schema.decodeSync(ServerSettings)(
          JSON.parse(yield* fs.readFileString(settingsPath)),
        );
        assert.deepEqual(saved.projectPreferences.a, {
          worktreeBranchPrefix: "team",
          initialModelSelection: null,
        });
      }).pipe(Effect.provide(layer())),
  );
  it.effect(
    "round-trips bounded model options without default stripping and rejects invalid presets atomically",
    () =>
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const model = {
          instanceId: ProviderInstanceId.make("codex"),
          model: "fixture-model",
          options: [{ id: "reasoningEffort", value: "high" }],
        };
        yield* settings.updateSettings({
          initialModelSelection: model,
          projectPreferences: { a: { initialModelSelection: model } },
        });
        const fs = yield* FileSystem.FileSystem;
        const { settingsPath } = yield* ServerConfig;
        const raw = yield* fs.readFileString(settingsPath);
        const decoded = Schema.decodeSync(ServerSettings)(JSON.parse(raw));
        assert.deepEqual(decoded.initialModelSelection, model);
        assert.deepEqual(decoded.projectPreferences.a?.initialModelSelection, model);
        const invalid = yield* settings
          .updateSettings({
            initialModelSelection: {
              ...model,
              options: [{ id: "environment", value: "arbitrary" }],
            },
          })
          .pipe(Effect.result);
        assert.equal(invalid._tag, "Failure");
        assert.equal(yield* fs.readFileString(settingsPath), raw);
      }).pipe(Effect.provide(layer())),
  );
});
