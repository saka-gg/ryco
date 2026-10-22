/**
 * Node self-update: a node reports which Ryco it runs, the newest release on its
 * channel, how it was installed, and whether it can install that release and
 * restart itself (`server.updateNode`). Clients follow the state through
 * `server.subscribeNodeUpdate`; a node advertises the methods with the
 * `nodeSelfUpdate` environment capability.
 *
 * @module nodeUpdate
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * How this node's Ryco is installed:
 * - `desktop-app`: the backend of a Ryco desktop app; the app's own updater replaces it.
 * - `npm-global` / `bun-global` / `pnpm-global`: a global `ryco-cli` package.
 * - `source-checkout`: a build inside a Ryco repository (`bun run node:update`).
 * - `ephemeral`: started through npx/bunx; nothing persistent to update.
 * - `unknown`: none of the above could be proven.
 */
export const NodeInstallationKind = Schema.Literals([
  "desktop-app",
  "npm-global",
  "bun-global",
  "pnpm-global",
  "source-checkout",
  "ephemeral",
  "unknown",
]);
export type NodeInstallationKind = typeof NodeInstallationKind.Type;

/** The service manager that restarts a `ryco service` node; absent in the foreground. */
export const NodeServiceManager = Schema.Literals(["launchd", "systemd"]);
export type NodeServiceManager = typeof NodeServiceManager.Type;

export const NodeInstallation = Schema.Struct({
  kind: NodeInstallationKind,
  service: Schema.NullOr(NodeServiceManager),
});
export type NodeInstallation = typeof NodeInstallation.Type;

/** Release channel: the npm dist-tag for CLI nodes, the update feed for desktop apps. */
export const NodeReleaseChannel = Schema.Literals(["latest", "nightly"]);
export type NodeReleaseChannel = typeof NodeReleaseChannel.Type;

export const NodeUpdateAvailability = Schema.Literals(["unknown", "current", "behind_latest"]);
export type NodeUpdateAvailability = typeof NodeUpdateAvailability.Type;

/**
 * One update attempt:
 * - `idle`: none since this process started, and no result from before the restart.
 * - `preparing`: installing (CLI) or downloading (desktop) the target release.
 * - `verifying`: running the installed release once before the restart (CLI).
 * - `waiting`: a desktop app counts down to its relaunch (`restartAt`); someone at that
 *   machine can still postpone it.
 * - `postponed`: someone at that machine postponed the relaunch. The download stays.
 * - `restarting`: handed off; the node is going down and comes back on the target.
 * - `succeeded` / `failed`: terminal. A success is reported by the restarted process.
 */
export const NodeUpdateRunStatus = Schema.Literals([
  "idle",
  "preparing",
  "verifying",
  "waiting",
  "postponed",
  "restarting",
  "succeeded",
  "failed",
]);
export type NodeUpdateRunStatus = typeof NodeUpdateRunStatus.Type;

export const NodeUpdateRun = Schema.Struct({
  status: NodeUpdateRunStatus,
  /** Correlates a client's `server.updateNode` with the result reported after the restart. */
  requestId: Schema.NullOr(TrimmedNonEmptyString),
  fromVersion: Schema.NullOr(TrimmedNonEmptyString),
  targetVersion: Schema.NullOr(TrimmedNonEmptyString),
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  /** `waiting` only: when the desktop app relaunches unless it is postponed. */
  restartAt: Schema.NullOr(IsoDateTime),
  /** Desktop download progress, 0–100, while `preparing`. */
  progressPercent: Schema.NullOr(Schema.Number),
  message: Schema.NullOr(TrimmedNonEmptyString),
  /** Tail of the installer's output, for a failed CLI install. */
  output: Schema.NullOr(Schema.String.check(Schema.isMaxLength(10_000))),
});
export type NodeUpdateRun = typeof NodeUpdateRun.Type;

export const NodeUpdateState = Schema.Struct({
  currentVersion: TrimmedNonEmptyString,
  /** Newest release on `channel`, `null` while unknown (offline, checks disabled, never checked). */
  latestVersion: Schema.NullOr(TrimmedNonEmptyString),
  channel: NodeReleaseChannel,
  availability: NodeUpdateAvailability,
  installation: NodeInstallation,
  /** Whether `server.updateNode` can install the release and restart this node by itself. */
  canUpdate: Schema.Boolean,
  /** Why it cannot, for display; `null` when it can. */
  manualReason: Schema.NullOr(TrimmedNonEmptyString),
  /** A command someone at that machine can run instead, when there is one. */
  manualCommand: Schema.NullOr(TrimmedNonEmptyString),
  checkedAt: Schema.NullOr(IsoDateTime),
  run: NodeUpdateRun,
});
export type NodeUpdateState = typeof NodeUpdateState.Type;

export const NodeUpdateCheckInput = Schema.Struct({});
export type NodeUpdateCheckInput = typeof NodeUpdateCheckInput.Type;

export const NodeUpdateInput = Schema.Struct({
  /**
   * The exact release the client showed. The node refuses another one, so a release
   * published between review and click is never installed unseen.
   */
  targetVersion: TrimmedNonEmptyString,
  /** Client-chosen id echoed in `run.requestId`, including after the restart. */
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type NodeUpdateInput = typeof NodeUpdateInput.Type;

export class NodeUpdateError extends Schema.TaggedError<NodeUpdateError>()("NodeUpdateError", {
  reason: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Node update failed: ${this.reason}`;
  }
}
