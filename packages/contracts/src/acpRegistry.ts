import { Effect, Schema } from "effect";

/** Registry identities are data, never executable paths or package-manager arguments. */
export const AcpRegistryAgentId = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
);
export const AcpRegistryVersion = Schema.String.check(
  Schema.isPattern(/^[0-9][a-zA-Z0-9.+_-]{0,127}$/),
);
export const AcpRegistrySettings = Schema.Struct({
  agentId: Schema.String.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
  version: Schema.String.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
  authMethodId: Schema.optionalKey(Schema.String).pipe(
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
});
export type AcpRegistrySettings = typeof AcpRegistrySettings.Type;
export const AcpRegistryAgent = Schema.Struct({
  id: AcpRegistryAgentId,
  version: AcpRegistryVersion,
  name: Schema.String,
  description: Schema.String,
  repository: Schema.optionalKey(Schema.String),
  website: Schema.optionalKey(Schema.String),
  icon: Schema.optionalKey(Schema.String),
  license: Schema.optionalKey(Schema.String),
  installable: Schema.Boolean,
  unavailableReason: Schema.optionalKey(Schema.String),
  installed: Schema.Boolean,
});
export type AcpRegistryAgent = typeof AcpRegistryAgent.Type;
export const AcpRegistryInstallInput = Schema.Struct({
  agentId: AcpRegistryAgentId,
  version: AcpRegistryVersion,
});
export type AcpRegistryInstallInput = typeof AcpRegistryInstallInput.Type;
export const AcpRegistryInstallation = Schema.Struct({
  agentId: AcpRegistryAgentId,
  version: AcpRegistryVersion,
  sha256: Schema.String,
});
export type AcpRegistryInstallation = typeof AcpRegistryInstallation.Type;
export const AcpRegistrySearchInput = Schema.Struct({
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
});
export const AcpRegistrySearchResult = Schema.Struct({ agents: Schema.Array(AcpRegistryAgent) });
