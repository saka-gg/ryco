import { Layer } from "effect";

import { GitNetworkPlaceholder } from "./GitNetworkPlaceholder.ts";
import { NodePathsPlaceholder } from "./NodePathsPlaceholder.ts";
import { ProjectExportPlaceholder } from "./ProjectExportPlaceholder.ts";
import { ProjectImportGitPlaceholder } from "./ProjectImportGitPlaceholder.ts";
import { ProjectImportsPlaceholder } from "./ProjectImportsPlaceholder.ts";
import { ProjectSetupCommandPlaceholder } from "./ProjectSetupCommandPlaceholder.ts";
import { ProjectTransfersPlaceholder } from "./ProjectTransfersPlaceholder.ts";

/**
 * The cross-node project copy services, each beneath the ones that use it: the import job
 * composes the import's git steps, transfers, setup command and node paths; export and the git
 * steps run network git. Each service's live layer replaces its placeholder here.
 */
export const ProjectCopyServicesLive = ProjectImportsPlaceholder.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      ProjectExportPlaceholder,
      ProjectTransfersPlaceholder,
      ProjectImportGitPlaceholder,
      ProjectSetupCommandPlaceholder,
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(GitNetworkPlaceholder, NodePathsPlaceholder)),
);
