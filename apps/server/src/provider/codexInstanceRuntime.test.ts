import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ServerSettings } from "@ryco/contracts";
import { Effect, Schema } from "effect";

import { resolveCodexInstanceRuntime } from "./codexInstanceRuntime.ts";

const settings = Schema.decodeSync(ServerSettings)({
  providers: { codex: { binaryPath: "/opt/codex/bin/codex", homePath: "/tmp/fixture-legacy" } },
  providerInstances: {
    codex_work: {
      driver: "codex",
      config: { shadowHomePath: "/tmp/fixture-work-shadow" },
      environment: [{ name: "CODEX_HOME", value: "/tmp/fixture-work", sensitive: false }],
    },
    codex_off: { driver: "codex", enabled: false },
    claude: { driver: "claudeAgent" },
  },
});
const resolve = (instanceId: string) =>
  resolveCodexInstanceRuntime(settings, ProviderInstanceId.make(instanceId));

describe("resolveCodexInstanceRuntime", () => {
  it.effect("resolves an instance's binary, homes and environment as its driver does", () =>
    Effect.gen(function* () {
      const runtime = yield* resolve("codex_work");

      assert.equal(runtime.binaryPath, "codex");
      assert.deepInclude(runtime.layout, {
        mode: "authOverlay",
        sharedHomePath: "/tmp/fixture-work",
        effectiveHomePath: "/tmp/fixture-work-shadow",
      });
      assert.equal(runtime.environment.CODEX_HOME, "/tmp/fixture-work");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("resolves the default instance the legacy Codex settings define", () =>
    Effect.gen(function* () {
      const runtime = yield* resolve("codex");

      assert.equal(runtime.binaryPath, "/opt/codex/bin/codex");
      assert.equal(runtime.layout.sharedHomePath, "/tmp/fixture-legacy");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["codex_off", "claude", "missing"])("refuses %s", (instanceId) =>
    Effect.gen(function* () {
      const error = yield* resolve(instanceId).pipe(Effect.flip);

      assert.equal(error._tag, "NoSuchElementError");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
