/**
 * ProjectFaviconResolver - Effect service contract for project icon discovery.
 *
 * Resolves a representative favicon or app icon file for a workspace by
 * checking common file locations and project source metadata.
 *
 * @module ProjectFaviconResolver
 */
import { Context, Data } from "effect";
import type { Effect } from "effect";

export interface ProjectFavicon {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/**
 * The icon could not be read in time (a stalled or failed read, or the
 * caller's deadline). Unlike `null` it is not an answer: callers must not
 * remember it as "no icon".
 */
export class ProjectFaviconUnavailable extends Data.TaggedError("ProjectFaviconUnavailable")<{
  readonly cwd: string;
}> {}

/**
 * ProjectFaviconResolverShape - Service API for project favicon lookup.
 */
export interface ProjectFaviconResolverShape {
  /**
   * Read a bounded favicon for the workspace without blocking the node's I/O.
   *
   * Returns `null` when no candidate icon file can be found, and fails with
   * {@link ProjectFaviconUnavailable} when the read did not finish.
   */
  readonly readIcon: (
    cwd: string,
  ) => Effect.Effect<ProjectFavicon | null, ProjectFaviconUnavailable>;
}

/**
 * ProjectFaviconResolver - Service tag for project favicon resolution.
 */
export class ProjectFaviconResolver extends Context.Service<
  ProjectFaviconResolver,
  ProjectFaviconResolverShape
>()("ryco/project/Services/ProjectFaviconResolver") {}
