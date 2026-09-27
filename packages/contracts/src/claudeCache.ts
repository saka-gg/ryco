import { ModelSelection } from "./orchestration.ts";
import { Schema } from "effect";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  RuntimeSessionId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** Observed main-loop usage. No cache validity or billing guarantee is represented. */
export const ClaudeCacheObservation = Schema.Struct({
  source: Schema.Literal("assistant-usage"),
  observedAt: IsoDateTime,
  runtimeSessionId: RuntimeSessionId,
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  modelSelection: Schema.optional(ModelSelection),
  messageId: TrimmedNonEmptyString,
  directInputTokens: NonNegativeInt,
  cacheReadInputTokens: NonNegativeInt,
  cacheWriteInputTokens: NonNegativeInt,
  observedTtlSeconds: Schema.optional(PositiveInt),
  mainLoopTotals: Schema.optional(
    Schema.Struct({
      source: Schema.Literal("result-usage"),
      observedAt: IsoDateTime,
      directInputTokens: NonNegativeInt,
      cacheReadInputTokens: NonNegativeInt,
      cacheWriteInputTokens: NonNegativeInt,
      outputTokens: NonNegativeInt,
    }),
  ),
});
export type ClaudeCacheObservation = typeof ClaudeCacheObservation.Type;
