import { createHash } from "node:crypto";

import {
  CONTEXT_HANDOFF_CONTEXT_VERSION,
  ContextHandoffAppliedBudget,
  ContextHandoffDigest,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
} from "@ryco/contracts";
import { Option, Schema } from "effect";

import {
  ContextHandoffBoundaryEntry,
  ContextHandoffCheckpointEntry,
  ContextHandoffDocument,
  ContextHandoffMessageEntry,
  ContextHandoffNoticeEntry,
  ContextHandoffPlanEntry,
  ContextHandoffSubagentEntry,
  ContextHandoffToolEntry,
  stableStringifyContextHandoff,
} from "./ContextHandoffBuilder.ts";
import { contextJsonFromContextHandoffInput } from "./ContextHandoffRenderer.ts";

export const CONTEXT_HANDOFF_DELIVERY_ARTIFACT_VERSION = 1;
export const CONTEXT_HANDOFF_RENDERER_VERSION = 1;

export const ContextHandoffRenderedDocument = Schema.Struct({
  version: Schema.Literal(CONTEXT_HANDOFF_CONTEXT_VERSION),
  mode: Schema.Literal("full-context-fresh-session"),
  provenance: ContextHandoffDocument.fields.provenance,
  thread: Schema.optional(ContextHandoffDocument.fields.thread),
  messages: Schema.optional(Schema.Array(ContextHandoffMessageEntry)),
  plans: Schema.optional(Schema.Array(ContextHandoffPlanEntry)),
  tools: Schema.optional(Schema.Array(ContextHandoffToolEntry)),
  checkpoints: Schema.optional(Schema.Array(ContextHandoffCheckpointEntry)),
  notices: Schema.optional(Schema.Array(ContextHandoffNoticeEntry)),
  subagents: Schema.optional(Schema.Array(ContextHandoffSubagentEntry)),
  priorHandoffs: Schema.optional(Schema.Array(ContextHandoffBoundaryEntry)),
});
export type ContextHandoffRenderedDocument = typeof ContextHandoffRenderedDocument.Type;

export const ContextHandoffDeliveryArtifact = Schema.Struct({
  ...ContextHandoffAppliedBudget.fields,
  artifactVersion: Schema.Literal(CONTEXT_HANDOFF_DELIVERY_ARTIFACT_VERSION),
  rendererVersion: Schema.Literal(CONTEXT_HANDOFF_RENDERER_VERSION),
  renderedContext: ContextHandoffRenderedDocument,
  providerInput: Schema.String,
  triggeringMessage: Schema.Struct({
    messageId: MessageId,
    text: Schema.String,
  }),
  renderedContextDigest: ContextHandoffDigest,
  providerInputDigest: ContextHandoffDigest,
  includedEntryCount: NonNegativeInt,
  totalEntryCount: NonNegativeInt,
  contextChars: NonNegativeInt,
  inputChars: PositiveInt,
  truncated: Schema.Boolean,
  preparedAt: IsoDateTime,
});
export type ContextHandoffDeliveryArtifact = typeof ContextHandoffDeliveryArtifact.Type;

export function digestContextHandoffUtf8(value: string): ContextHandoffDigest {
  return ContextHandoffDigest.make(createHash("sha256").update(value, "utf8").digest("hex"));
}

const decodeRenderedContextJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(ContextHandoffRenderedDocument),
);

/**
 * Artifacts stored by earlier versions could digest context JSON that decoding then changed:
 * compaction marked nested objects `truncated` and cut strings after whitespace, and decoding
 * drops or trims both. Their digest still covers the JSON the provider received, which the
 * provider input holds verbatim, and their stored context must be exactly what that JSON
 * decodes to.
 */
function hasValidSentContextDigest(artifact: ContextHandoffDeliveryArtifact): boolean {
  const sentJson = contextJsonFromContextHandoffInput(
    artifact.providerInput,
    artifact.triggeringMessage.text,
  );
  if (
    sentJson === undefined ||
    artifact.renderedContextDigest !== digestContextHandoffUtf8(sentJson)
  ) {
    return false;
  }
  const sent = decodeRenderedContextJson(sentJson);
  return (
    Option.isSome(sent) &&
    stableStringifyContextHandoff(sent.value) ===
      stableStringifyContextHandoff(artifact.renderedContext)
  );
}

export function hasValidContextHandoffDeliveryDigests(
  artifact: ContextHandoffDeliveryArtifact,
): boolean {
  if (artifact.providerInputDigest !== digestContextHandoffUtf8(artifact.providerInput)) {
    return false;
  }
  return (
    artifact.renderedContextDigest ===
      digestContextHandoffUtf8(stableStringifyContextHandoff(artifact.renderedContext)) ||
    hasValidSentContextDigest(artifact)
  );
}

export function makeContextHandoffDeliveryArtifact(
  input: typeof ContextHandoffAppliedBudget.Type & {
    readonly renderedContext: ContextHandoffRenderedDocument;
    readonly renderedContextJson: string;
    readonly providerInput: string;
    readonly triggeringMessageId: MessageId;
    readonly triggeringMessage: string;
    readonly includedEntryCount: number;
    readonly totalEntryCount: number;
    readonly contextChars: number;
    readonly inputChars: number;
    readonly truncated: boolean;
    readonly preparedAt: string;
  },
): ContextHandoffDeliveryArtifact {
  const canonicalRenderedContext = stableStringifyContextHandoff(input.renderedContext);
  if (canonicalRenderedContext !== input.renderedContextJson) {
    throw new Error("Rendered context JSON does not match its structured document");
  }
  const artifact = Schema.decodeUnknownSync(ContextHandoffDeliveryArtifact)({
    maxInputChars: input.maxInputChars ?? null,
    budgetSource: input.budgetSource ?? null,
    contextWindowTokens: input.contextWindowTokens ?? null,
    artifactVersion: CONTEXT_HANDOFF_DELIVERY_ARTIFACT_VERSION,
    rendererVersion: CONTEXT_HANDOFF_RENDERER_VERSION,
    renderedContext: input.renderedContext,
    providerInput: input.providerInput,
    triggeringMessage: {
      messageId: input.triggeringMessageId,
      text: input.triggeringMessage,
    },
    renderedContextDigest: digestContextHandoffUtf8(input.renderedContextJson),
    providerInputDigest: digestContextHandoffUtf8(input.providerInput),
    includedEntryCount: input.includedEntryCount,
    totalEntryCount: input.totalEntryCount,
    contextChars: input.contextChars,
    inputChars: input.inputChars,
    truncated: input.truncated,
    preparedAt: input.preparedAt,
  });
  // The decoded artifact is what gets stored; if decoding changed the context, every later
  // reuse or inspection would fail its digest check, so refuse it now.
  if (stableStringifyContextHandoff(artifact.renderedContext) !== input.renderedContextJson) {
    throw new Error("Rendered context does not survive decoding unchanged");
  }
  return artifact;
}
