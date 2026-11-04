/**
 * GitNetworkLive - network git for a cross-node copy: ls-remote, the remote check the copy dialog
 * runs before it offers "Clone from origin", and the commands the import's clone, submodule and
 * LFS steps run.
 *
 * Each command runs non-interactively (`NON_INTERACTIVE_GIT_ENV`). The URL must be one the server
 * clones from (`validateCloneRemoteUrl`: https, ssh or scp-style; plain http is refused), and an
 * https URL gets the source-control provider's clone credentials through a scoped askpass, as
 * `sourceControl.cloneRepository` does. ssh stays the user's: `core.sshCommand` is set to a
 * batch-mode ssh only while `GIT_SSH`, `GIT_SSH_COMMAND` and `core.sshCommand` are all unset, and
 * no host key is ever accepted on the user's behalf. Whatever git prints is credential-redacted.
 *
 * @module GitNetworkLive
 */
import * as NodeOS from "node:os";

import {
  ProjectCopyError,
  type ProjectCheckRemoteAccessInput,
  type ProjectCheckRemoteAccessResult,
} from "@ryco/contracts/project-copy";
import {
  alternateRemoteUrl,
  classifyRemoteUrl,
  type GitRemoteUrlKind,
  isCloneableRemoteKind,
  redactGitCredentials,
  remoteUrlHasPassword,
  sanitizeRemoteUrl,
  sshHostOfRemoteUrl,
} from "@ryco/shared/gitRemoteUrl";
import { Effect, FileSystem, Layer, Path, Result, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";

import {
  GIT_HOST_KEY_FAILURE,
  GIT_UNREACHABLE_PATTERNS,
  gitFailureSummary,
} from "../../sourceControl/gitCloneCommon.ts";
import {
  CLONE_REMOTE_URL_SYNTAX_DETAIL,
  resolveCloneCredentials,
  validateCloneRemoteUrl,
  withCloneAskpass,
} from "../../sourceControl/gitCloneAccess.ts";
import { SourceControlProviderRegistry } from "../../sourceControl/SourceControlProviderRegistry.ts";
import { NON_INTERACTIVE_GIT_ENV } from "../../vcs/GitVcsDriver.ts";
import { GitNetworkError, type GitNetworkFailureReason } from "../Errors.ts";
import {
  GIT_DETAIL_MAX_CHARS,
  runProjectCopyGit,
  tailOfText,
  type ProjectCopyGitInput,
  type ProjectCopyGitOutput,
} from "../gitProcess.ts";
import {
  GitNetwork,
  type GitLsRemoteInput,
  type GitNetworkCommandInput,
  type GitRemoteRef,
} from "../Services/GitNetwork.ts";

export const LS_REMOTE_TIMEOUT_MS = 30_000;
/** A remote advertising more than this many bytes of refs is refused rather than read in part. */
const LS_REMOTE_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const SSH_COMMAND_PROBE_TIMEOUT_MS = 10_000;
/** Never a passphrase or host-key prompt, and a dead host fails in seconds, not minutes. */
export const BATCH_SSH_COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=15";

/** What the copy dialog shows for a failure: `host-key-unknown <host>`, or git's reason. */
export function remoteAccessDetail(error: GitNetworkError): string {
  return error.reason === "host-key-unknown"
    ? `host-key-unknown ${error.host ?? "unknown"}`
    : gitFailureSummary(error.detail) || error.reason;
}

const nonEmpty = (value: string | undefined) => value !== undefined && value.trim().length > 0;

interface CheckedRemote {
  readonly url: string;
  readonly kind: GitRemoteUrlKind;
}

export const makeGitNetwork = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const providers = yield* SourceControlProviderRegistry;

  const runGit = (input: ProjectCopyGitInput) =>
    runProjectCopyGit(input).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

  const failure = (
    operation: string,
    reason: GitNetworkFailureReason,
    detail: string,
    extra?: { readonly host?: string | null; readonly exitCode?: number | null },
  ) =>
    new GitNetworkError({
      operation,
      reason,
      detail: tailOfText(redactGitCredentials(detail), GIT_DETAIL_MAX_CHARS) || reason,
      host: extra?.host ?? null,
      exitCode: extra?.exitCode ?? null,
    });

  const checkRemote = (
    operation: string,
    remoteUrl: string,
    allowLocalRemote: boolean,
  ): Effect.Effect<CheckedRemote, GitNetworkError> => {
    const kind = classifyRemoteUrl(remoteUrl);
    if (allowLocalRemote && (kind === "file" || kind === "local" || kind === "http")) {
      return Effect.succeed({ url: remoteUrl.trim(), kind });
    }
    if (kind === "http") {
      return Effect.fail(
        failure(
          operation,
          "insecure-transport",
          "Plain http:// remotes are not cloned over the network; send the files instead.",
        ),
      );
    }
    // WHATWG `URL` (in `validateCloneRemoteUrl`) also reads `https:\\host/x` or `ssh:host/x` as
    // https or ssh, where git sees an ssh host named `https`: only what both accept is cloned.
    const validated = isCloneableRemoteKind(kind)
      ? validateCloneRemoteUrl(remoteUrl)
      : Result.fail(CLONE_REMOTE_URL_SYNTAX_DETAIL);
    return Result.match(validated, {
      onFailure: (detail) => Effect.fail(failure(operation, "invalid-url", detail)),
      onSuccess: (url) =>
        !allowLocalRemote && remoteUrlHasPassword(url)
          ? Effect.fail(
              failure(operation, "invalid-url", "Remote URLs must not contain a password."),
            )
          : Effect.succeed({ url, kind }),
    });
  };

  /**
   * Whether to add the batch-mode `core.sshCommand`: only for a command that may run ssh, and
   * only while the user configured none. A probe that fails counts as configured, so the user's
   * own ssh setup is never overridden by accident.
   */
  const shouldAddBatchSsh = (input: GitNetworkCommandInput, remote: CheckedRemote | null) => {
    if (remote !== null && remote.kind !== "ssh" && remote.kind !== "scp") {
      return Effect.succeed(false);
    }
    const env = { ...process.env, ...input.env };
    if (nonEmpty(env.GIT_SSH) || nonEmpty(env.GIT_SSH_COMMAND)) return Effect.succeed(false);
    return runGit({
      operation: `${input.operation}.sshCommandProbe`,
      cwd: input.cwd,
      args: ["config", "--get", "core.sshCommand"],
      env: input.env,
      timeoutMs: SSH_COMMAND_PROBE_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
    }).pipe(
      Effect.map((probe) => probe.exitCode !== 0 || probe.stdout.trim().length === 0),
      Effect.orElseSucceed(() => false),
    );
  };

  const toFailure = (
    operation: string,
    output: ProjectCopyGitOutput,
    remote: CheckedRemote | null,
  ): GitNetworkError => {
    const stderr = output.stderrTail;
    const detail = stderr.trim().length > 0 ? stderr : `git exited with code ${output.exitCode}.`;
    if (GIT_HOST_KEY_FAILURE.test(stderr)) {
      const host =
        (remote ? sshHostOfRemoteUrl(remote.url) : null) ??
        /host key is known for (\S+?)(?:\s|$)/i.exec(stderr)?.[1] ??
        null;
      return failure(operation, "host-key-unknown", detail, { host, exitCode: output.exitCode });
    }
    const reason = GIT_UNREACHABLE_PATTERNS.some((pattern) => pattern.test(stderr))
      ? "unreachable"
      : "failed";
    return failure(operation, reason, detail, { exitCode: output.exitCode });
  };

  const runNetworkGit = Effect.fn("GitNetwork.runNetworkGit")(function* (
    input: GitNetworkCommandInput,
  ) {
    const remote =
      input.remoteUrl === null
        ? null
        : yield* checkRemote(input.operation, input.remoteUrl, input.allowLocalRemote === true);
    const credentials =
      remote !== null && remote.kind === "https"
        ? yield* resolveCloneCredentials({
            registry: providers,
            remoteUrl: remote.url,
            provider: null,
          }).pipe(
            Effect.mapError((cause) =>
              failure(
                input.operation,
                "internal",
                `The clone credentials could not be read: ${cause.message}`,
              ),
            ),
          )
        : null;
    const effectiveUrl = credentials?.remoteUrl ?? remote?.url ?? null;
    const args =
      input.remoteUrl === null || effectiveUrl === null
        ? input.args
        : input.args.map((arg) => (arg === input.remoteUrl ? effectiveUrl : arg));
    const batchSsh = yield* shouldAddBatchSsh(input, remote);

    const output = yield* withCloneAskpass(credentials?.authentication ?? null, (askpassEnv) =>
      runGit({
        operation: input.operation,
        cwd: input.cwd,
        args: batchSsh ? ["-c", `core.sshCommand=${BATCH_SSH_COMMAND}`, ...args] : args,
        env: { ...input.env, ...askpassEnv },
        timeoutMs: input.timeoutMs,
        stallTimeoutMs: input.stallTimeoutMs,
        maxOutputBytes: input.maxOutputBytes,
        observer: input.observer,
      }),
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError((error) =>
        Schema.is(GitNetworkError)(error)
          ? error
          : failure(
              input.operation,
              "internal",
              `The askpass could not be set up: ${error.message}`,
            ),
      ),
    );
    if (output.exitCode !== 0) return yield* toFailure(input.operation, output, remote);
    return output;
  });

  const runGitNetworkCommand = (input: GitNetworkCommandInput) =>
    runNetworkGit(input).pipe(
      Effect.map((output) => ({ stdout: output.stdout, stderrTail: output.stderrTail })),
    );

  const lsRemote = Effect.fn("GitNetwork.lsRemote")(function* (input: GitLsRemoteInput) {
    const operation = "GitNetwork.lsRemote";
    const output = yield* runNetworkGit({
      operation,
      cwd: input.cwd ?? NodeOS.tmpdir(),
      args: [
        "ls-remote",
        ...(input.heads ? ["--heads"] : []),
        ...(input.tags ? ["--tags"] : []),
        "--",
        input.remoteUrl,
      ],
      remoteUrl: input.remoteUrl,
      allowLocalRemote: input.allowLocalRemote,
      timeoutMs: input.timeoutMs ?? LS_REMOTE_TIMEOUT_MS,
      maxOutputBytes: LS_REMOTE_MAX_OUTPUT_BYTES,
    });
    if (output.stdoutTruncated) {
      return yield* failure(operation, "failed", "The remote advertises too many refs to read.");
    }
    const refs: Array<GitRemoteRef> = [];
    for (const line of output.stdout.split("\n")) {
      const match = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\t(\S.*)$/.exec(line.trimEnd());
      if (match?.[1] && match[2]) refs.push({ oid: match[1], ref: match[2] });
    }
    return refs;
  });

  const checkRemoteAccess = Effect.fn("GitNetwork.checkRemoteAccess")(function* (
    input: ProjectCheckRemoteAccessInput,
  ) {
    const reachableAs = (alternate: string | null): ProjectCheckRemoteAccessResult => ({
      reachable: true,
      alternateRemoteUrl: alternate,
      detail: null,
    });
    const probe = (remoteUrl: string) =>
      lsRemote({ remoteUrl, heads: true, tags: false }).pipe(Effect.result);
    const given = yield* probe(input.remoteUrl);
    if (Result.isSuccess(given)) return reachableAs(null);
    const error = given.failure;
    if (error.reason === "internal") {
      return yield* new ProjectCopyError({
        code: "internal",
        message: tailOfText(error.detail, GIT_DETAIL_MAX_CHARS) || "git could not run.",
      });
    }
    if (error.reason !== "invalid-url" && error.reason !== "insecure-transport") {
      const alternate = alternateRemoteUrl(input.remoteUrl);
      if (alternate !== null && Result.isSuccess(yield* probe(alternate))) {
        return reachableAs(alternate);
      }
    }
    const unreachable: ProjectCheckRemoteAccessResult = {
      reachable: false,
      alternateRemoteUrl: null,
      detail: remoteAccessDetail(error),
    };
    return unreachable;
  });

  return GitNetwork.of({
    env: NON_INTERACTIVE_GIT_ENV,
    runGitNetworkCommand,
    lsRemote,
    checkRemoteAccess,
    alternateRemoteUrl,
    sanitizeRemoteUrl,
    classifyRemoteUrl,
  });
});

export const GitNetworkLive = Layer.effect(GitNetwork, makeGitNetwork);
