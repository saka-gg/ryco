import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const OpinionatedPluginId = Schema.Literals([
  "rtk",
  "caveman",
  "token-optimizer",
  "token-savior",
  "lean-ctx",
]);
export type OpinionatedPluginId = typeof OpinionatedPluginId.Type;

export const OpinionatedPluginScope = Schema.Literals(["global", "provider-instance"]);
export type OpinionatedPluginScope = typeof OpinionatedPluginScope.Type;

export const OpinionatedPluginImpact = Schema.Literals(["tool-output", "assistant-output"]);
export type OpinionatedPluginImpact = typeof OpinionatedPluginImpact.Type;

export const OpinionatedPluginStatusState = Schema.Literals([
  "installed",
  "not-installed",
  "unsupported",
  "error",
]);
export type OpinionatedPluginStatusState = typeof OpinionatedPluginStatusState.Type;

export const OpinionatedPluginCatalogItem = Schema.Struct({
  id: OpinionatedPluginId,
  name: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  impact: OpinionatedPluginImpact,
  scope: OpinionatedPluginScope,
  homepageUrl: TrimmedNonEmptyString,
  docsUrl: Schema.optional(TrimmedNonEmptyString),
  supportedDrivers: Schema.Array(ProviderDriverKind).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  installNotes: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type OpinionatedPluginCatalogItem = typeof OpinionatedPluginCatalogItem.Type;

export const OpinionatedPluginTargetKind = Schema.Literals(["global", "provider-instance"]);
export type OpinionatedPluginTargetKind = typeof OpinionatedPluginTargetKind.Type;

export const OpinionatedPluginStatus = Schema.Struct({
  pluginId: OpinionatedPluginId,
  targetKind: OpinionatedPluginTargetKind,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  providerDriver: Schema.optional(ProviderDriverKind),
  providerDisplayName: Schema.optional(TrimmedNonEmptyString),
  state: OpinionatedPluginStatusState,
  canInstall: Schema.Boolean,
  checkedAt: IsoDateTime,
  version: Schema.optional(TrimmedNonEmptyString),
  detail: Schema.optional(TrimmedNonEmptyString),
  manualSteps: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type OpinionatedPluginStatus = typeof OpinionatedPluginStatus.Type;

export const OpinionatedPluginListResult = Schema.Struct({
  plugins: Schema.Array(OpinionatedPluginCatalogItem),
});
export type OpinionatedPluginListResult = typeof OpinionatedPluginListResult.Type;

export const OpinionatedPluginStatusResult = Schema.Struct({
  statuses: Schema.Array(OpinionatedPluginStatus),
});
export type OpinionatedPluginStatusResult = typeof OpinionatedPluginStatusResult.Type;

export const OpinionatedPluginCheckInput = Schema.Struct({
  pluginId: Schema.optional(OpinionatedPluginId),
});
export type OpinionatedPluginCheckInput = typeof OpinionatedPluginCheckInput.Type;

export const OpinionatedPluginInstallInput = Schema.Struct({
  pluginId: OpinionatedPluginId,
  providerInstanceId: Schema.optional(ProviderInstanceId),
});
export type OpinionatedPluginInstallInput = typeof OpinionatedPluginInstallInput.Type;

export const OpinionatedPluginInstallResult = Schema.Struct({
  pluginId: OpinionatedPluginId,
  status: OpinionatedPluginStatus,
  commands: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
});
export type OpinionatedPluginInstallResult = typeof OpinionatedPluginInstallResult.Type;

export class OpinionatedPluginError extends Schema.TaggedError<OpinionatedPluginError>()(
  "OpinionatedPluginError",
  {
    pluginId: Schema.optional(OpinionatedPluginId),
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.pluginId
      ? `Opinionated plugin '${this.pluginId}' failed: ${this.detail}`
      : `Opinionated plugin operation failed: ${this.detail}`;
  }
}
