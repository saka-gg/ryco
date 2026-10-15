import type { RepositoryIdentity } from "@ryco/contracts";
import { Context, Schema } from "effect";
import type { Effect } from "effect";

/**
 * `git` could not answer (timeout, spawn failure, an unexpected exit). Distinct from "no
 * repository" and "no remote", which resolve to `null`: a failed probe must never be recorded as
 * the project's identity.
 */
export class RepositoryIdentityProbeError extends Schema.TaggedError<RepositoryIdentityProbeError>()(
  "RepositoryIdentityProbeError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Repository identity probe ${this.operation} failed: ${this.detail}`;
  }
}

export interface RepositoryIdentityResolverShape {
  /**
   * Probe `git` for the identity of `cwd`, cached in memory for a short while. A failed probe
   * reads as `null` here and is not cached.
   */
  readonly resolve: (cwd: string) => Effect.Effect<RepositoryIdentity | null>;
  /**
   * Probe again, bypassing and then refreshing the in-memory cache. Used by the persisted
   * identity sync when a repository's config changed; absent in narrow test doubles. Fails when
   * `git` could not answer, so the caller keeps what it knew.
   */
  readonly refresh?: (
    cwd: string,
  ) => Effect.Effect<RepositoryIdentity | null, RepositoryIdentityProbeError>;
}

export class RepositoryIdentityResolver extends Context.Service<
  RepositoryIdentityResolver,
  RepositoryIdentityResolverShape
>()("ryco/project/Services/RepositoryIdentityResolver") {}
