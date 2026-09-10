/**
 * ProjectFaviconResolver - Effect service contract for project icon discovery.
 *
 * Resolves a representative favicon or app icon file for a workspace by
 * checking common file locations and project source metadata.
 *
 * @module ProjectFaviconResolver
 */
import { Context } from "effect";
import type { Effect } from "effect";

export interface ProjectFavicon {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/**
 * ProjectFaviconResolverShape - Service API for project favicon lookup.
 */
export interface ProjectFaviconResolverShape {
  /**
   * Read a bounded favicon for the workspace without blocking the node's I/O.
   *
   * Returns `null` when no candidate icon file can be found.
   */
  readonly readIcon: (cwd: string) => Effect.Effect<ProjectFavicon | null>;
}

/**
 * ProjectFaviconResolver - Service tag for project favicon resolution.
 */
export class ProjectFaviconResolver extends Context.Service<
  ProjectFaviconResolver,
  ProjectFaviconResolverShape
>()("ryco/project/Services/ProjectFaviconResolver") {}
