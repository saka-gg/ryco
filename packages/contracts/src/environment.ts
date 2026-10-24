import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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
  requiredWorktreeBootstrap: Schema.optional(Schema.Boolean),
  repositoryIdentity: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  projectIcons: Schema.optional(Schema.Boolean),
  storageManagement: Schema.optionalKey(Schema.Boolean),
  environmentIcon: Schema.optionalKey(Schema.Boolean),
  projectPreferences: Schema.optionalKey(Schema.Boolean),
  threadSidebarUndo: Schema.optional(Schema.Boolean),
  threadSnooze: Schema.optional(Schema.Boolean),
  threadSettlement: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /**
   * The node keeps the automatic settlement rule (`threadAutoSettleAfterDays`) and
   * carries it in its shell snapshot; absent on older servers, whose threads follow
   * each client's own rule and which drop the key from settings patches.
   */
  nodeAutoSettlement: Schema.optionalKey(Schema.Boolean),
  threadPriorityRanking: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  worktreeSubmoduleSettings: Schema.optionalKey(Schema.Boolean),
  /** Usage-limit settings and the resume/snooze worker; absent on older servers. */
  usageLimitRecovery: Schema.optionalKey(Schema.Boolean),
  /**
   * The `responseStreamingMode` setting (turn, paragraph, token); absent on older servers,
   * which drop the key from settings patches and only know the legacy token switch.
   */
  responseStreamingModes: Schema.optionalKey(Schema.Boolean),
  /** Server-owned worktree notes (`notes.list` / `notes.command`); absent on older servers. */
  worktreeNotes: Schema.optionalKey(Schema.Boolean),
  /**
   * Tasks with links, files and several chats each (`server.*LocalTask*`, bootstrap
   * starts, task file uploads); absent on older servers.
   */
  localTasks: Schema.optionalKey(Schema.Boolean),
  /** `threads.fork` (chat forking); absent on older servers. */
  threadFork: Schema.optionalKey(Schema.Boolean),
  /**
   * `thread.conversation.revert` (rewind the conversation and keep the files); absent on
   * older servers, which offer only the revert that restores files.
   */
  conversationRevert: Schema.optionalKey(Schema.Boolean),
  /**
   * `projects.searchEntries` accepts an empty query (the shallowest entries,
   * which also warms the workspace index); absent on older servers.
   */
  projectSearchEmptyQuery: Schema.optionalKey(Schema.Boolean),
  /** `projects.searchContent` (find in files); absent on older servers. */
  projectContentSearch: Schema.optionalKey(Schema.Boolean),
  /**
   * CLIProxyAPI hub settings and reads (`server.readCliProxyHubs` / `server.testCliProxyHub`);
   * absent on older servers, which drop `cliProxyHubs` from settings patches.
   */
  cliProxyHubs: Schema.optionalKey(Schema.Boolean),
  /** Stores Cloudflare Access service tokens and sends them with CLIProxyAPI management calls. */
  cliProxyCloudflareAccess: Schema.optionalKey(Schema.Boolean),
  /** `provider.prewarmSession` (start a thread's session ahead of its send); absent on older servers. */
  providerSessionPrewarm: Schema.optionalKey(Schema.Boolean),
  /** `provider.readProjectCommands` (per-directory skills and slash commands); absent on older servers. */
  providerProjectCommands: Schema.optionalKey(Schema.Boolean),
  /**
   * `server.subscribeNodeUpdate` / `server.checkNodeUpdate` / `server.updateNode`: the node
   * reports its Ryco release and installation and can update itself; absent on older servers.
   */
  nodeSelfUpdate: Schema.optionalKey(Schema.Boolean),
  /**
   * `git.runStackedAction` honours `stagedOnly` and `vcs.readLocalChanges` returns
   * `stagedRevision`; absent on older servers, which drop `stagedOnly` and commit every change.
   */
  stagedOnlyCommit: Schema.optionalKey(Schema.Boolean),
  /**
   * `terminal.write` honours `requireIdle` (types only into a shell it verifies idle, else
   * `TerminalBusyError`); absent on older servers, which drop the key and write unguarded.
   */
  terminalWriteRequireIdle: Schema.optionalKey(Schema.Boolean),
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
