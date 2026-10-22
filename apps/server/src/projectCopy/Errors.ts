import { ProjectImportErrorCode } from "@ryco/contracts/project-copy";
import { Schema } from "effect";

// ===============================
// Cross-node project copy errors
// ===============================
//
// The RPC-facing services (`NodePaths`, `ProjectExport`, `ProjectTransfers`, `ProjectImports`)
// fail with the contract's `ProjectCopyError`. The step services the import job composes fail
// with the richer errors below, which the job turns into its snapshot's step error or a warning.

export const GitNetworkFailureReason = Schema.Literals([
  /** Not an https, ssh or scp-style URL `validateCloneRemoteUrl` accepts. */
  "invalid-url",
  /** Plain `http://`: never cloned over (the copy offers "Send files" instead). */
  "insecure-transport",
  /** DNS, refused connections, missing repositories and refused credentials alike; see `detail`. */
  "unreachable",
  /** An ssh host this node never accepted. Its key is never accepted automatically. */
  "host-key-unknown",
  "timeout",
  /** No output for the stall timeout (a clone that stopped transferring). */
  "stalled",
  /** git exited non-zero for a reason that is not about the network. */
  "failed",
  "internal",
]);
export type GitNetworkFailureReason = typeof GitNetworkFailureReason.Type;

/** A git command that talks to a remote failed. */
export class GitNetworkError extends Schema.TaggedError<GitNetworkError>()("GitNetworkError", {
  operation: Schema.String,
  reason: GitNetworkFailureReason,
  /** git's own words, bounded and credential-redacted; safe for snapshots and logs. */
  detail: Schema.String,
  /** The ssh host whose key is unknown (`host-key-unknown`), else null. */
  host: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Int),
}) {
  override get message(): string {
    return `${this.operation} failed (${this.reason}): ${this.detail}`;
  }
}

/**
 * One import step failed. `code` and `message` become the snapshot's `error` as they are
 * (`message` is user-facing and credential-redacted); `detail` is git's stderr tail for the
 * output tail.
 */
export class ProjectImportStepError extends Schema.TaggedError<ProjectImportStepError>()(
  "ProjectImportStepError",
  {
    code: ProjectImportErrorCode,
    message: Schema.String,
    detail: Schema.NullOr(Schema.String),
  },
) {}

/** The setup command could not start; a command that ran and failed is a result, not this. */
export class ProjectSetupCommandError extends Schema.TaggedError<ProjectSetupCommandError>()(
  "ProjectSetupCommandError",
  {
    reason: Schema.Literals(["spawn-failed", "cwd-missing", "internal"]),
    message: Schema.String,
  },
) {}
