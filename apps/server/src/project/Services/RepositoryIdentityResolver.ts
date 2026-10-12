import type { RepositoryIdentity } from "@ryco/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface RepositoryIdentityResolverShape {
  /** Probe `git` for the identity of `cwd`, cached in memory for a short while. */
  readonly resolve: (cwd: string) => Effect.Effect<RepositoryIdentity | null>;
  /**
   * Probe again, bypassing and then refreshing the in-memory cache. Used by the persisted
   * identity sync when a repository's config changed; absent in narrow test doubles.
   */
  readonly refresh?: (cwd: string) => Effect.Effect<RepositoryIdentity | null>;
}

export class RepositoryIdentityResolver extends Context.Service<
  RepositoryIdentityResolver,
  RepositoryIdentityResolverShape
>()("ryco/project/Services/RepositoryIdentityResolver") {}
