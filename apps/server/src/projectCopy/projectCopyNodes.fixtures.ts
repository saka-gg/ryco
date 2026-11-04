/**
 * In-process project copy nodes for the cross-node tests: each node has its own state directory,
 * SQLite database and orchestration engine, with project copy services on top. Only the
 * source-control provider registry is a stub (the fixtures' remotes have no forge).
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Context, Effect, Layer } from "effect";

import { ServerConfig } from "../config.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { layerConfig as SqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { ProjectAvatarStoreLive } from "../project/Layers/ProjectAvatarStore.ts";
import { RepositoryIdentityResolverLive } from "../project/Layers/RepositoryIdentityResolver.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { WorkspaceAccessPolicyLayer } from "../workspace/Layers/WorkspaceAccessPolicy.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import type { TempRoots } from "./projectCopyGit.fixtures.ts";

/** Everything beneath the project copy services, as the server provides it. */
const nodeBaseLayer = (baseDir: string) =>
  OrchestrationLayerLive.pipe(
    Layer.provideMerge(ProjectionProjectRepositoryLive),
    Layer.provideMerge(
      Layer.unwrap(
        Effect.gen(function* () {
          const config = yield* ServerConfig;
          return ProjectAvatarStoreLive({ dataDir: config.stateDir });
        }),
      ),
    ),
    Layer.provideMerge(RepositoryIdentityResolverLive),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(
      Layer.mock(SourceControlProviderRegistry)({ detectProviderFromRemoteUrl: () => null }),
    ),
    Layer.provideMerge(WorkspacePathsLive),
    Layer.provideMerge(WorkspaceAccessPolicyLayer(undefined)),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(SqlitePersistenceLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );

type NodeBaseServices = Layer.Success<ReturnType<typeof nodeBaseLayer>>;

/**
 * Builds a node in the test's scope, with `copyServices` on top; a second call builds a second,
 * separate node. `ProjectCopyServicesLive` builds the services at once,
 * `ProjectCopyServicesDeferredLive` the way `server.ts` does, behind the stand-ins that load them
 * on first use.
 */
export const startProjectCopyNode = <ROut, E>(
  roots: TempRoots,
  name: string,
  copyServices: Layer.Layer<ROut, E, NodeBaseServices>,
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      copyServices.pipe(Layer.provideMerge(nodeBaseLayer(roots.make(`ryco-xnode-${name}-`)))),
    );
    return {
      stateDir: Context.get(context, ServerConfig).stateDir,
      run: <A, E2>(effect: Effect.Effect<A, E2, ROut | NodeBaseServices>) =>
        Effect.provideContext(effect, context),
    };
  });
