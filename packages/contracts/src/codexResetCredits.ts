import { Schema } from "effect";
import { ProviderInstanceId } from "./providerInstance.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const CodexResetCredit = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  grantedAt: Schema.Number,
  expiresAt: Schema.optional(Schema.NullOr(Schema.Number)),
  status: Schema.Literals(["available", "redeeming", "redeemed", "unknown"]),
  resetType: Schema.Literals(["codexRateLimits", "unknown"]),
});
export const CodexResetCredits = Schema.Struct({
  availableCount: Schema.Number,
  // Absent means unknown; [] means fetched and empty. Count is authoritative.
  credits: Schema.optional(Schema.Array(CodexResetCredit)),
});
export type CodexResetCredits = typeof CodexResetCredits.Type;
export const CodexResetCreditOutcome = Schema.Literals([
  "reset",
  "alreadyRedeemed",
  "noCredit",
  "nothingToReset",
]);
export type CodexResetCreditOutcome = typeof CodexResetCreditOutcome.Type;
export const CodexResetCreditInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  accountBinding: TrimmedNonEmptyString,
  idempotencyKey: TrimmedNonEmptyString,
});
export type CodexResetCreditInput = typeof CodexResetCreditInput.Type;
export const CodexResetCreditAccount = Schema.Struct({
  accountBinding: Schema.optional(TrimmedNonEmptyString),
  accountLabel: Schema.optional(Schema.String),
  credits: Schema.optional(CodexResetCredits),
  unavailableReason: Schema.optional(Schema.String),
});
export type CodexResetCreditAccount = typeof CodexResetCreditAccount.Type;
export class CodexResetCreditError extends Schema.TaggedError<CodexResetCreditError>()(
  "CodexResetCreditError",
  {
    message: Schema.String,
  },
) {}
