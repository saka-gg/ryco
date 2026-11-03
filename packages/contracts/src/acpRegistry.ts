import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Registry identities are data, never executable paths or package-manager arguments. */
export const AcpRegistryAgentId = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
);
export const AcpRegistryVersion = Schema.String.check(
  Schema.isPattern(/^[0-9][a-zA-Z0-9.+_-]{0,127}$/),
);
/** Where an ACP agent comes from: a pinned registry install, or an executable already on the node. */
export const AcpAgentSource = Schema.Literals(["registry", "local"]);
export type AcpAgentSource = typeof AcpAgentSource.Type;
export const ACP_LOCAL_COMMAND_MAX_ARGS = 64;
const withoutNul = Schema.makeFilter((value: string) => !value.includes("\0"));
/** An absolute path or a name on the node's PATH; the server resolves it before every start. */
export const AcpLocalCommandPath = Schema.String.check(Schema.isMaxLength(4096), withoutNul);
/** One literal argument: no shell, variables, or globbing ever apply. */
export const AcpLocalCommandArgument = Schema.String.check(Schema.isMaxLength(4096), withoutNul);
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
  source: AcpAgentSource.pipe(
    Schema.withDecodingDefault(Effect.succeed("registry" as const)),
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
  command: AcpLocalCommandPath.pipe(
    Schema.withDecodingDefault(Effect.succeed("")),
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
  args: Schema.Array(AcpLocalCommandArgument)
    .check(Schema.isMaxLength(ACP_LOCAL_COMMAND_MAX_ARGS))
    .pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
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
