/**
 * ProjectCopyServicesDeferred - the cross-node project copy services (node paths, network git,
 * export, transfers, the import job), loaded on first use.
 *
 * Their code (`ProjectCopyServices.ts` and everything beneath it, about 200 KB bundled) is loaded
 * with `import()` the first time any of them is called, so it stays off the server's boot path
 * (serverBundleBoundaries.test.ts). This layer provides the services' tags with thin stand-ins
 * that build the real services once, in a fiber of this layer's scope: concurrent first callers
 * wait for the same build, a caller that goes away (a dropped connection) leaves it to the next
 * one, and a failed load is retried by the next caller. The real services live in this layer's
 * scope, so they stop with the server as before.
 *
 * A start loads them only when an earlier process left copy work behind
 * (`projectCopyNeedsStartupWork`): then `recoverOnStartup` builds them, which settles imports left
 * running, sweeps transfers and exports, and replays what interrupted imports owe.
 *
 * @module ProjectCopyServicesDeferred
 */
import { ProjectCopyError } from "@ryco/contracts/project-copy";
import {
  alternateRemoteUrl,
  classifyRemoteUrl,
  sanitizeRemoteUrl,
} from "@ryco/shared/gitRemoteUrl";
import { Cause, Context, Deferred, Effect, Exit, Layer, Stream } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { NON_INTERACTIVE_GIT_ENV } from "../../vcs/GitVcsDriver.ts";
import { GitNetworkError } from "../Errors.ts";
import { projectCopyNeedsStartupWork } from "../projectCopyStartup.ts";
import { GitNetwork, type GitNetworkShape } from "../Services/GitNetwork.ts";
import { NodePaths, type NodePathsShape } from "../Services/NodePaths.ts";
import { ProjectExport, type ProjectExportShape } from "../Services/ProjectExport.ts";
import { ProjectImports, type ProjectImportsShape } from "../Services/ProjectImports.ts";
import { ProjectTransfers, type ProjectTransfersShape } from "../Services/ProjectTransfers.ts";
import type { ProjectCopyServicesLive } from "./ProjectCopyServices.ts";

/** What the real services are built with, captured when this layer is built. */
type ProjectCopyServicesRequirements = Layer.Services<typeof ProjectCopyServicesLive>;

/** What this layer needs from the lazily loaded `ProjectCopyServices.ts`. */
export interface ProjectCopyServicesModule {
  readonly ProjectCopyServicesLive: typeof ProjectCopyServicesLive;
}

const loadProjectCopyServicesModule = (): Promise<ProjectCopyServicesModule> =>
  import("./ProjectCopyServices.ts");

interface LoadedProjectCopyServices {
  readonly nodePaths: NodePathsShape;
  readonly gitNetwork: GitNetworkShape;
  readonly projectExport: ProjectExportShape;
  readonly projectTransfers: ProjectTransfersShape;
  readonly projectImports: ProjectImportsShape;
}

/** Why the services are missing, as each service's own error. */
const UNAVAILABLE = "Project copy could not be loaded on this node.";
const unavailable = () => new ProjectCopyError({ code: "internal", message: UNAVAILABLE });
const networkUnavailable = (operation: string) =>
  new GitNetworkError({
    operation,
    reason: "internal",
    detail: UNAVAILABLE,
    host: null,
    exitCode: null,
  });

export const makeProjectCopyServicesDeferred = Effect.fnUntraced(function* (
  load: () => Promise<ProjectCopyServicesModule> = loadProjectCopyServicesModule,
) {
  const services = yield* Effect.context<ProjectCopyServicesRequirements>();
  const scope = yield* Effect.scope;
  const config = yield* ServerConfig;
  const sql = yield* SqlClient.SqlClient;

  let built: Deferred.Deferred<LoadedProjectCopyServices, Cause.Cause<unknown>> | null = null;
  const build = (done: Deferred.Deferred<LoadedProjectCopyServices, Cause.Cause<unknown>>) =>
    Effect.promise(() => load()).pipe(
      Effect.flatMap((module) => Layer.buildWithScope(module.ProjectCopyServicesLive, scope)),
      Effect.map((context): LoadedProjectCopyServices => ({
        nodePaths: Context.get(context, NodePaths),
        gitNetwork: Context.get(context, GitNetwork),
        projectExport: Context.get(context, ProjectExport),
        projectTransfers: Context.get(context, ProjectTransfers),
        projectImports: Context.get(context, ProjectImports),
      })),
      Effect.provideContext(services),
      Effect.sandbox,
      Effect.tapError((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError("project copy services could not be loaded", {
              cause: Cause.pretty(cause),
            }),
      ),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (Exit.isFailure(exit) && built === done) built = null;
        }).pipe(Effect.andThen(Deferred.done(done, exit))),
      ),
    );
  // Starting the build is uninterruptible, so a caller interrupted right after claiming it cannot
  // leave later callers waiting for a build that never started.
  const loaded: Effect.Effect<
    LoadedProjectCopyServices,
    Cause.Cause<unknown>
  > = Effect.uninterruptibleMask((restore) =>
    Effect.suspend(() => {
      if (built !== null) return restore(Deferred.await(built));
      const done = Deferred.makeUnsafe<LoadedProjectCopyServices, Cause.Cause<unknown>>();
      built = done;
      return Effect.forkIn(build(done), scope).pipe(Effect.andThen(restore(Deferred.await(done))));
    }),
  );
  /** The loaded services, a load failure as a `ProjectCopyError`. */
  const copy = loaded.pipe(Effect.mapError(unavailable));
  /** The loaded services; a load failure is a defect where the method cannot fail. */
  const infallible = loaded.pipe(Effect.orDie);

  const nodePaths = NodePaths.of({
    pathHints: (input) => Effect.flatMap(copy, (s) => s.nodePaths.pathHints(input)),
    searchDirectories: (input) => Effect.flatMap(copy, (s) => s.nodePaths.searchDirectories(input)),
    previewDestination: (input) =>
      Effect.flatMap(copy, (s) => s.nodePaths.previewDestination(input)),
    judgeProjectDestination: (input) =>
      Effect.flatMap(copy, (s) => s.nodePaths.judgeProjectDestination(input)),
    resolveCodeRoots: () => Effect.flatMap(copy, (s) => s.nodePaths.resolveCodeRoots()),
  });

  // The URL helpers and the environment are plain values: they never load the services.
  const gitNetwork = GitNetwork.of({
    env: NON_INTERACTIVE_GIT_ENV,
    runGitNetworkCommand: (input) =>
      loaded.pipe(
        Effect.mapError(() => networkUnavailable(input.operation)),
        Effect.flatMap((s) => s.gitNetwork.runGitNetworkCommand(input)),
      ),
    lsRemote: (input) =>
      loaded.pipe(
        Effect.mapError(() => networkUnavailable("GitNetwork.lsRemote")),
        Effect.flatMap((s) => s.gitNetwork.lsRemote(input)),
      ),
    checkRemoteAccess: (input) =>
      Effect.flatMap(copy, (s) => s.gitNetwork.checkRemoteAccess(input)),
    alternateRemoteUrl,
    sanitizeRemoteUrl,
    classifyRemoteUrl,
  });

  const projectExport = ProjectExport.of({
    inspect: (input) => Effect.flatMap(copy, (s) => s.projectExport.inspect(input)),
    start: (request) => Effect.flatMap(copy, (s) => s.projectExport.start(request)),
    readChunk: (input, channel, maxChunkBytes) =>
      Effect.flatMap(copy, (s) => s.projectExport.readChunk(input, channel, maxChunkBytes)),
    dispose: (input) => Effect.flatMap(copy, (s) => s.projectExport.dispose(input)),
    sweep: () => Effect.flatMap(infallible, (s) => s.projectExport.sweep()),
  });

  const projectTransfers = ProjectTransfers.of({
    begin: (input, channel, maxChunkBytes) =>
      Effect.flatMap(copy, (s) => s.projectTransfers.begin(input, channel, maxChunkBytes)),
    append: (input, channel, maxChunkBytes) =>
      Effect.flatMap(copy, (s) => s.projectTransfers.append(input, channel, maxChunkBytes)),
    commit: (input) => Effect.flatMap(copy, (s) => s.projectTransfers.commit(input)),
    abort: (input) => Effect.flatMap(copy, (s) => s.projectTransfers.abort(input)),
    claimForImport: (input) =>
      Effect.flatMap(copy, (s) => s.projectTransfers.claimForImport(input)),
    releaseImport: (importId) =>
      Effect.flatMap(infallible, (s) => s.projectTransfers.releaseImport(importId)),
    sweep: () => Effect.flatMap(infallible, (s) => s.projectTransfers.sweep()),
  });

  const projectImports = ProjectImports.of({
    start: (input) => Effect.flatMap(copy, (s) => s.projectImports.start(input)),
    get: (importId) => Effect.flatMap(copy, (s) => s.projectImports.get(importId)),
    subscribe: (input) => Stream.unwrap(Effect.map(copy, (s) => s.projectImports.subscribe(input))),
    cancel: (input) => Effect.flatMap(copy, (s) => s.projectImports.cancel(input)),
    list: (input) => Effect.flatMap(copy, (s) => s.projectImports.list(input)),
    discard: (input) => Effect.flatMap(copy, (s) => s.projectImports.discard(input)),
    // Never fails, as the real one: a start with nothing left behind loads nothing.
    recoverOnStartup: () =>
      Effect.suspend(() =>
        built !== null
          ? Effect.succeed(true)
          : projectCopyNeedsStartupWork(config.stateDir).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            ),
      ).pipe(
        Effect.flatMap((needed) =>
          needed
            ? loaded.pipe(
                Effect.flatMap((s) => s.projectImports.recoverOnStartup()),
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.void,
                ),
              )
            : Effect.void,
        ),
      ),
  });

  return Context.make(NodePaths, nodePaths).pipe(
    Context.add(GitNetwork, gitNetwork),
    Context.add(ProjectExport, projectExport),
    Context.add(ProjectTransfers, projectTransfers),
    Context.add(ProjectImports, projectImports),
  );
});

export const ProjectCopyServicesDeferredLive = Layer.effectContext(
  makeProjectCopyServicesDeferred(),
);
