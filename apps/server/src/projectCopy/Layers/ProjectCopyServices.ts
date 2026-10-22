import { Layer } from "effect";

import { GitNetworkLive } from "./GitNetworkLive.ts";
import { NodePathsLive } from "./NodePathsLive.ts";
import { ProjectExportLive } from "./ProjectExportLive.ts";
import { ProjectImportGitLive } from "./ProjectImportGitLive.ts";
import { ProjectImportsLive } from "./ProjectImportsLive.ts";
import { ProjectSetupCommandLive } from "./ProjectSetupCommandLive.ts";
import { ProjectTransfersLive } from "./ProjectTransfersLive.ts";

/**
 * The cross-node project copy services, each beneath the ones that use it: the import job
 * composes the import's git steps, transfers, setup command, network git and node paths; export
 * and the import's git steps run network git. Everything else they need (config, persistence,
 * orchestration, the avatar store, the workspace access policy, the git driver and the
 * source-control providers) comes from the runtime dependencies beneath them in `server.ts`.
 */
export const ProjectCopyServicesLive = ProjectImportsLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      ProjectExportLive,
      ProjectTransfersLive,
      ProjectImportGitLive,
      ProjectSetupCommandLive,
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(GitNetworkLive, NodePathsLive)),
);
