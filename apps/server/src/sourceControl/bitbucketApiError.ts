import { Schema } from "effect";

export class BitbucketApiError extends Schema.TaggedError<BitbucketApiError>()(
  "BitbucketApiError",
  {
    operation: Schema.String,
    detail: Schema.String,
    status: Schema.optional(Schema.Number),
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
