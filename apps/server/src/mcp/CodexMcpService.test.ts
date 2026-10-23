import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@ryco/contracts";
import { Effect, FileSystem, Layer, Path } from "effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeCodexMcpService } from "./CodexMcpService.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Records the environment of every spawned process and refuses to start it. */
function recordingSpawner() {
  const environments: Array<Readonly<Record<string, string | undefined>>> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    const { options } = command as unknown as {
      readonly options: { readonly env?: Readonly<Record<string, string | undefined>> };
    };
    environments.push(options.env ?? {});
    return Effect.fail(
      PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "ChildProcess",
        method: "spawn",
        description: "test spawner refuses to start Codex",
      }),
    );
  });
  return { environments, spawner };
}

it.layer(NodeServices.layer)("CodexMcpService", (it) => {
  describe("Codex homes", () => {
    it.effect("uses the homes the instance's own environment selects, like its driver", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "ryco-codex-mcp-" });
        const serverHome = path.join(root, "server-codex");
        const instanceHome = path.join(root, "instance-codex");
        const shadowHome = path.join(root, "account-shadow");
        yield* fileSystem.makeDirectory(serverHome, { recursive: true });
        yield* fileSystem.makeDirectory(instanceHome, { recursive: true });
        yield* fileSystem.writeFileString(path.join(serverHome, "config.toml"), "# server\n");
        yield* fileSystem.writeFileString(path.join(instanceHome, "config.toml"), "# instance\n");
        // The server runs with a different Codex home than the instance selects.
        vi.stubEnv("CODEX_HOME", serverHome);

        const { environments, spawner } = recordingSpawner();
        const service = yield* makeCodexMcpService.pipe(
          Effect.provide(
            Layer.mergeAll(
              ServerSettingsService.layerTest({
                providers: { codex: { enabled: false } },
                providerInstances: {
                  [ProviderInstanceId.make("codex_work")]: {
                    driver: ProviderDriverKind.make("codex"),
                    environment: [{ name: "CODEX_HOME", value: instanceHome, sensitive: false }],
                    config: { shadowHomePath: shadowHome },
                  },
                },
              }),
              ServerConfig.layerTest(root, path.join(root, "ryco")),
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
            ),
          ),
        );

        const { workspaces, issues } = yield* service.listWorkspaces;

        expect(issues).toEqual([]);
        expect(workspaces.map((workspace) => workspace.sharedHomePath)).toEqual([instanceHome]);
        expect(yield* fileSystem.readLink(path.join(shadowHome, "config.toml"))).toBe(
          path.join(instanceHome, "config.toml"),
        );

        yield* service.listServers({ workspaceId: workspaces[0]!.id }).pipe(Effect.flip);

        expect(environments).toHaveLength(1);
        expect(environments[0]).toMatchObject({
          CODEX_HOME: shadowHome,
          CODEX_SQLITE_HOME: instanceHome,
        });
      }),
    );
  });
});
