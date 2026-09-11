import { Effect, Option, Schema } from "effect";

import {
  EnvironmentId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const ExecutionEnvironmentPlatformOs = Schema.Literals([
  "darwin",
  "linux",
  "windows",
  "unknown",
]);
export type ExecutionEnvironmentPlatformOs = typeof ExecutionEnvironmentPlatformOs.Type;

export const ExecutionEnvironmentPlatformArch = Schema.Literals(["arm64", "x64", "other"]);
export type ExecutionEnvironmentPlatformArch = typeof ExecutionEnvironmentPlatformArch.Type;

export const ENVIRONMENT_MACHINE_KINDS = [
  "laptop",
  "desktop",
  "mini-pc",
  "workstation",
  "server",
  "cloud",
  "linux",
  "windows",
] as const;
export type EnvironmentMachineKind = (typeof ENVIRONMENT_MACHINE_KINDS)[number];
export const EnvironmentMachineKind: Schema.Codec<EnvironmentMachineKind> =
  Schema.Literals(ENVIRONMENT_MACHINE_KINDS);

/** Future icon kinds degrade to Automatic without rejecting a node snapshot. */
export const EnvironmentMachineHint: Schema.Codec<EnvironmentMachineKind | null> = Schema.NullOr(
  EnvironmentMachineKind,
).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(null))));

export const ExecutionEnvironmentPlatform = Schema.Struct({
  os: ExecutionEnvironmentPlatformOs,
  arch: ExecutionEnvironmentPlatformArch,
  machine: Schema.optionalKey(EnvironmentMachineHint),
});
export type ExecutionEnvironmentPlatform = typeof ExecutionEnvironmentPlatform.Type;

export const ExecutionEnvironmentCapabilities = Schema.Struct({
  repositoryIdentity: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  projectIcons: Schema.optional(Schema.Boolean),
  environmentIcon: Schema.optionalKey(Schema.Boolean),
  threadSnooze: Schema.optional(Schema.Boolean),
  threadSettlement: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  threadPriorityRanking: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  fileAttachments: Schema.optional(Schema.Struct({ maxUploadBytes: NonNegativeInt })),
});
export type ExecutionEnvironmentCapabilities = typeof ExecutionEnvironmentCapabilities.Type;

export const ExecutionEnvironmentDescriptor = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  platform: ExecutionEnvironmentPlatform,
  serverVersion: TrimmedNonEmptyString,
  capabilities: ExecutionEnvironmentCapabilities,
});
export type ExecutionEnvironmentDescriptor = typeof ExecutionEnvironmentDescriptor.Type;

export const EnvironmentConnectionState = Schema.Literals([
  "connecting",
  "connected",
  "disconnected",
  "error",
]);
export type EnvironmentConnectionState = typeof EnvironmentConnectionState.Type;

export const RepositoryIdentityLocator = Schema.Struct({
  source: Schema.Literal("git-remote"),
  remoteName: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
});
export type RepositoryIdentityLocator = typeof RepositoryIdentityLocator.Type;

export const RepositoryRemote = Schema.Struct({
  name: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  provider: Schema.optionalKey(TrimmedNonEmptyString),
  ownerRepo: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RepositoryRemote = typeof RepositoryRemote.Type;

export const RepositoryIdentity = Schema.Struct({
  canonicalKey: TrimmedNonEmptyString,
  locator: RepositoryIdentityLocator,
  rootPath: Schema.optionalKey(TrimmedNonEmptyString),
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  provider: Schema.optionalKey(TrimmedNonEmptyString),
  owner: Schema.optionalKey(TrimmedNonEmptyString),
  name: Schema.optionalKey(TrimmedNonEmptyString),
  remotes: Schema.optional(Schema.Array(RepositoryRemote)).pipe(
    Schema.withDecodingDefault(Effect.succeed([] as ReadonlyArray<RepositoryRemote>)),
  ),
});
export type RepositoryIdentity = typeof RepositoryIdentity.Type;

export const ScopedProjectRef = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
});
export type ScopedProjectRef = typeof ScopedProjectRef.Type;

export const ScopedThreadRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type ScopedThreadRef = typeof ScopedThreadRef.Type;

export const ScopedThreadSessionRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type ScopedThreadSessionRef = typeof ScopedThreadSessionRef.Type;
