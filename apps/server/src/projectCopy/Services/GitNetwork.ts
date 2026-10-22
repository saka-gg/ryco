/**
 * GitNetwork - every git command of a cross-node copy that talks to a remote.
 *
 * Runs non-interactively (no terminal prompt, no askpass dialog, no credential-manager UI) in
 * the C locale, so progress and errors parse the same on every node. The user's own ssh setup
 * stays in charge: a batch-mode `core.sshCommand` is added only when neither `GIT_SSH`,
 * `GIT_SSH_COMMAND` nor `core.sshCommand` is set, and host keys are never accepted on the
 * user's behalf. Private https remotes authenticate through the source-control provider's clone
 * credentials (a scoped askpass), exactly like `sourceControl.cloneRepository`.
 *
 * @module GitNetwork
 */
import type {
  GitObjectId,
  ProjectCheckRemoteAccessInput,
  ProjectCheckRemoteAccessResult,
  ProjectCopyError,
} from "@ryco/contracts/project-copy";
import type { GitRemoteUrlKind } from "@ryco/shared/gitRemoteUrl";
import { Context } from "effect";
import type { Effect } from "effect";

import type { GitNetworkError } from "../Errors.ts";
import type { ProjectCopyProcessObserver } from "./ProjectCopyProcess.ts";

export interface GitNetworkCommandInput {
  readonly operation: string;
  /** Where git runs: a repository root, or the parent of a clone's staging directory. */
  readonly cwd: string;
  /**
   * The arguments after `git` and the network options this service adds. Positional arguments
   * follow `--` (or `--end-of-options`).
   */
  readonly args: ReadonlyArray<string>;
  /**
   * The remote the command talks to; validated (https, ssh or scp-style, as
   * `validateCloneRemoteUrl` accepts), and it picks the clone credentials. When those credentials
   * apply, the argument equal to `remoteUrl` is replaced by the URL without user info.
   *
   * Null for a command that talks to the remotes the repository itself names (submodules, LFS):
   * it gets the non-interactive environment and the batch-mode ssh, but never clone credentials,
   * which must not reach a host they were not issued for.
   */
  readonly remoteUrl: string | null;
  /**
   * A remote this node's own repository already has configured (the export's primary remote):
   * `file://` URLs and local paths pass too. Never set for a URL that came from a client, another
   * node or an agent.
   */
  readonly allowLocalRemote?: boolean | undefined;
  /** Overall limit (ls-remote 30 s, clone 30 min, submodules 10 min). */
  readonly timeoutMs: number;
  /**
   * Fails `stalled` after this long without any output (clone: 5 min). git prints no progress
   * to a pipe unless asked (`--progress`, `GIT_LFS_FORCE_PROGRESS=1`): without it a long but
   * healthy transfer reads as a stall.
   */
  readonly stallTimeoutMs?: number | undefined;
  /** Added to the non-interactive environment, e.g. `GIT_LFS_SKIP_SMUDGE=1`. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** Bounds the collected stdout; stderr is kept as a tail. */
  readonly maxOutputBytes?: number | undefined;
  /** `onOutput` receives stderr in whole lines (progress updates end with `\r`), redacted. */
  readonly observer?: ProjectCopyProcessObserver | undefined;
}

export interface GitNetworkCommandResult {
  readonly stdout: string;
  /** The end of stderr, credential-redacted. */
  readonly stderrTail: string;
}

export interface GitLsRemoteInput {
  readonly remoteUrl: string;
  /** As on `GitNetworkCommandInput`: the export reads its own primary remote with it. */
  readonly allowLocalRemote?: boolean | undefined;
  readonly heads: boolean;
  readonly tags: boolean;
  /** Default 30 s. */
  readonly timeoutMs?: number | undefined;
  /**
   * The repository whose configuration applies (its `core.sshCommand`, credential helpers), e.g.
   * the export's checkout; default: a directory outside any repository.
   */
  readonly cwd?: string | undefined;
}

/** One ref a remote advertises. */
export interface GitRemoteRef {
  readonly ref: string;
  readonly oid: GitObjectId;
}

export interface GitNetworkShape {
  /**
   * `LC_ALL=C LANG=C GIT_TERMINAL_PROMPT=0 SSH_ASKPASS_REQUIRE=never GCM_INTERACTIVE=never`:
   * the environment of every import and export git process, local ones included.
   */
  readonly env: Readonly<Record<string, string>>;
  /** Runs one git command against `remoteUrl`; interrupting it cancels (kills and waits). */
  readonly runGitNetworkCommand: (
    input: GitNetworkCommandInput,
  ) => Effect.Effect<GitNetworkCommandResult, GitNetworkError>;
  /** `git ls-remote [--heads] [--tags] -- <url>`. */
  readonly lsRemote: (
    input: GitLsRemoteInput,
  ) => Effect.Effect<ReadonlyArray<GitRemoteRef>, GitNetworkError>;
  /**
   * Whether this node can reach the remote, trying the https ↔ ssh alternate when the given
   * form fails. An unknown ssh host key reports `host-key-unknown <host>` as the detail. Fails
   * only for input it refuses (an invalid or plain-http URL is `reachable: false` with a reason).
   */
  readonly checkRemoteAccess: (
    input: ProjectCheckRemoteAccessInput,
  ) => Effect.Effect<ProjectCheckRemoteAccessResult, ProjectCopyError>;
  /** The scp-ssh form of an https remote and the reverse, from host, owner and repository; else null. */
  readonly alternateRemoteUrl: (remoteUrl: string) => string | null;
  /**
   * Drops a password always, and the username only for http(s): `ssh://git@…` and `git@host:…`
   * keep theirs, which their authentication needs.
   */
  readonly sanitizeRemoteUrl: (remoteUrl: string) => string;
  readonly classifyRemoteUrl: (remoteUrl: string) => GitRemoteUrlKind;
}

export class GitNetwork extends Context.Service<GitNetwork, GitNetworkShape>()(
  "ryco/projectCopy/Services/GitNetwork",
) {}
