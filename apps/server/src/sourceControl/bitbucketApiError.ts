import { Schema } from "effect";
import { SourceControlProviderErrorReason } from "@ryco/contracts";

export class BitbucketApiError extends Schema.TaggedError<BitbucketApiError>()(
  "BitbucketApiError",
  {
    operation: Schema.String,
    detail: Schema.String,
    status: Schema.optional(Schema.Number),
    /** Why Bitbucket refused, from the HTTP status and headers. */
    failureKind: Schema.optional(SourceControlProviderErrorReason),
    /** Epoch ms Bitbucket named for the retry (`Retry-After`), with failureKind "rate-limited". */
    retryAt: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Bitbucket API failed in ${this.operation}: ${this.detail}`;
  }
}

export function isBitbucketApiError(cause: unknown): cause is BitbucketApiError {
  return Schema.is(BitbucketApiError)(cause);
}
