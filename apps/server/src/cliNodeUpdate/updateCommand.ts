/**
 * `ryco update`: update this machine's node (or a paired remote) from a terminal, through the
 * node's own one-click update.
 *
 * The node does the work exactly as for the apps' Update button (`server.updateNode`): one
 * update at a time, the registry checked again, the release installed and checked against a
 * copy of the database, a snapshot and a marker written, the service restarted and rolled back
 * when the new release fails to start. This command only picks the target, asks, starts it and
 * follows the run across the restart (port of T3's `t3 update`, which also defers to the
 * running service). Loaded through `import()`; the server pieces it needs are handed in.
 */
import {
  type NodeReleaseChannel,
  type NodeUpdateRun,
  type NodeUpdateState,
  WS_METHODS,
} from "@ryco/contracts";
import { Cause, Console, Duration, Effect, Exit, Option, Stream } from "effect";
import { FetchHttpClient } from "effect/http";

import { CliRemoteError } from "../cliRemote/remotes.ts";
import {
  ThreadCliError,
  type ThreadCliTarget,
  withThreadConnection,
} from "../cliThread/threadCommands.ts";
import { isNewerNodeRelease, RYCO_CLI_PACKAGE } from "../nodeUpdate/installation.ts";
import { fetchNpmDistTagVersion } from "../npmRegistry.ts";

/** How long the command follows a run, restart included. */
const FOLLOW_TIMEOUT = Duration.minutes(10);

/**
 * Where a run settles: done, failed, or (desktop app) relaunch postponed by someone at that
 * machine. `waiting` is not: the desktop app relaunches on its own when the countdown ends.
 */
const SETTLED_STATUSES: ReadonlySet<NodeUpdateRun["status"]> = new Set([
  "succeeded",
  "failed",
  "postponed",
]);

const STATUS_LINES: Partial<Record<NodeUpdateRun["status"], (run: NodeUpdateRun) => string>> = {
  preparing: (run) => `Installing ${run.targetVersion ?? "the release"}…`,
  verifying: () => "Checking the new release against a copy of the database…",
  waiting: (run) =>
    `The app restarts${run.restartAt === null ? " shortly" : ` at ${run.restartAt}`} unless someone at that machine postpones it…`,
  restarting: () => "Restarting the node…",
};

/** `latest` is what people call stable. */
const channelName = (channel: NodeReleaseChannel) => (channel === "latest" ? "stable" : channel);

const capitalized = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

export interface UpdateCliOptions<R = never> {
  readonly target: ThreadCliTarget;
  /** "this node" or the remote's quoted name, for messages. */
  readonly nodeLabel: string;
  /** `--channel`; null keeps the node's own channel. */
  readonly channel: NodeReleaseChannel | null;
  readonly yes: boolean;
  readonly json: boolean;
  /** Whether a person can answer a prompt (stdin and stdout are a terminal). */
  readonly interactive: boolean;
  readonly confirm: (message: string) => Effect.Effect<boolean, never, R>;
  /** The newest version on an npm dist-tag (`ryco-cli@<channel>`), or null. */
  readonly fetchLatestOnChannel: (channel: NodeReleaseChannel) => Effect.Effect<string | null>;
  /** Correlates this request with the run the node reports after its restart. */
  readonly requestId: string;
  readonly followTimeout?: Duration.Duration;
}

const fail = (message: string) => Effect.fail(new ThreadCliError({ message }));

/** The newest `ryco-cli` release on an npm dist-tag, or null when the registry does not answer. */
export const fetchLatestRycoRelease = (channel: NodeReleaseChannel) =>
  fetchNpmDistTagVersion(RYCO_CLI_PACKAGE, channel).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.orElseSucceed(() => null),
  );

/** A fresh check (owner): the registry again, for the release about to be installed. */
const checkState = (target: ThreadCliTarget) =>
  withThreadConnection(target, (client) => client[WS_METHODS.serverCheckNodeUpdate]({}));

/** The node's current update state without a check (viewer access, no registry needed). */
const currentState = (target: ThreadCliTarget) =>
  withThreadConnection(target, (client) =>
    client[WS_METHODS.serverSubscribeNodeUpdate]({}).pipe(
      Stream.runHead,
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new CliRemoteError({ message: "The node's update feed ended." })),
          onSome: Effect.succeed,
        }),
      ),
    ),
  );

const describeLastRun = (run: NodeUpdateRun): string | null => {
  if (run.status === "idle" || run.targetVersion === null) return null;
  const when = run.finishedAt ?? run.startedAt;
  const outcome =
    run.status === "succeeded"
      ? "succeeded"
      : run.status === "failed"
        ? `failed${run.message === null ? "" : `: ${run.message}`}`
        : run.status;
  return `Last update, to ${run.targetVersion}${when === null ? "" : ` (${when})`}: ${outcome}.`;
};

/** `ryco update --check`: where the node stands, without changing anything. */
export const runUpdateCheck = (input: {
  readonly target: ThreadCliTarget;
  readonly nodeLabel: string;
  readonly json: boolean;
  readonly channel: NodeReleaseChannel | null;
  readonly fetchLatestOnChannel: (channel: NodeReleaseChannel) => Effect.Effect<string | null>;
}) =>
  Effect.gen(function* () {
    const state = yield* currentState(input.target);
    const otherChannel =
      input.channel !== null && input.channel !== state.channel ? input.channel : null;
    const otherLatest =
      otherChannel === null ? null : yield* input.fetchLatestOnChannel(otherChannel);
    if (input.json) {
      yield* Console.log(
        JSON.stringify(
          otherChannel === null
            ? state
            : { ...state, requested: { channel: otherChannel, latestVersion: otherLatest } },
        ),
      );
      return state;
    }
    const lastRun = describeLastRun(state.run);
    yield* Console.log(
      [
        `${capitalized(input.nodeLabel)} runs ${state.currentVersion} (${channelName(state.channel)}).`,
        state.latestVersion === null
          ? "The newest release is not known yet."
          : `Newest ${channelName(state.channel)} release: ${state.latestVersion}.`,
        ...(otherChannel === null
          ? []
          : [
              otherLatest === null
                ? `Could not find the newest ${channelName(otherChannel)} release.`
                : `Newest ${channelName(otherChannel)} release: ${otherLatest}.`,
            ]),
        ...(lastRun === null ? [] : [lastRun]),
        ...(state.canUpdate
          ? []
          : [
              state.manualReason ?? "It cannot update itself.",
              ...(state.manualCommand === null ? [] : [`Run: ${state.manualCommand}`]),
            ]),
      ].join("\n"),
    );
    return state;
  });

/**
 * Follows the node's update state until the run with `requestId` settles. The node restarts in
 * the middle: the subscription drops, `withThreadConnection` reconnects, and the first state
 * after the restart reports how the run ended (from the node's update marker).
 */
const followRun = <R>(options: UpdateCliOptions<R>) => {
  let lastStatus: NodeUpdateRun["status"] | null = null;
  const report = (state: NodeUpdateState) =>
    Effect.gen(function* () {
      const { run } = state;
      if (options.json || run.requestId !== options.requestId || run.status === lastStatus) return;
      lastStatus = run.status;
      const line = STATUS_LINES[run.status]?.(run);
      if (line !== undefined) yield* Console.log(line);
    });
  const timeout = options.followTimeout ?? FOLLOW_TIMEOUT;
  return withThreadConnection(options.target, (client) =>
    client[WS_METHODS.serverSubscribeNodeUpdate]({}).pipe(
      Stream.tap(report),
      Stream.filter(
        (state) =>
          state.run.requestId === options.requestId && SETTLED_STATUSES.has(state.run.status),
      ),
      Stream.runHead,
      // A subscription that ends without the outcome ended with the old process: reconnect.
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new CliRemoteError({ message: "The node's update feed ended." })),
          onSome: Effect.succeed,
        }),
      ),
    ),
  ).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        fail(
          `The node did not report how the update ended within ${Duration.format(timeout)}. Check it with \`ryco update --check\`.`,
        ),
    }),
  );
};

/** The connection dropped (or never came up), as opposed to an answer the node gave. */
const isConnectionLoss = (cause: Cause.Cause<unknown>) => {
  const error = Cause.findErrorOption(cause);
  return (
    Option.isSome(error) &&
    typeof error.value === "object" &&
    error.value !== null &&
    "_tag" in error.value &&
    (error.value._tag === "RpcClientError" || error.value._tag === "CliRemoteError")
  );
};

export const runUpdateCli = <R>(options: UpdateCliOptions<R>) =>
  Effect.gen(function* () {
    const label = options.nodeLabel;
    const before = yield* checkState(options.target);
    if (!before.canUpdate) {
      return yield* fail(
        [
          before.manualReason ?? `${capitalized(label)} cannot update itself.`,
          ...(before.manualCommand === null ? [] : [`Run: ${before.manualCommand}`]),
        ].join("\n"),
      );
    }
    if (!SETTLED_STATUSES.has(before.run.status) && before.run.status !== "idle") {
      return yield* fail(`An update is already running on ${label}.`);
    }

    const otherChannel =
      options.channel !== null && options.channel !== before.channel ? options.channel : null;
    if (otherChannel !== null && before.installation.kind === "desktop-app") {
      return yield* fail(
        "The desktop app follows its own channel: Ryco Nightly is a separate app.",
      );
    }
    if (otherChannel === null && before.availability === "current") {
      yield* Console.log(
        options.json
          ? JSON.stringify(before)
          : `${capitalized(label)} runs ${before.currentVersion}, the newest ${channelName(before.channel)} release.`,
      );
      return before;
    }
    const targetVersion =
      otherChannel === null
        ? before.latestVersion
        : yield* options.fetchLatestOnChannel(otherChannel);
    if (targetVersion === null) {
      return yield* fail(
        `Could not find the newest ${channelName(otherChannel ?? before.channel)} release. Try again.`,
      );
    }
    if (!isNewerNodeRelease(targetVersion, before.currentVersion)) {
      return yield* fail(
        otherChannel === null
          ? `${capitalized(label)} runs ${before.currentVersion}; ${targetVersion} is not newer.`
          : `The newest ${channelName(otherChannel)} release, ${targetVersion}, is not newer than ${before.currentVersion}. A channel switch never goes back to an older release: run this again after the next ${channelName(otherChannel)} release.`,
      );
    }

    if (!options.yes) {
      if (!options.interactive) {
        return yield* fail(
          "Updating restarts the node. Run `ryco update` in a terminal to confirm, or pass --yes.",
        );
      }
      const switching =
        otherChannel === null
          ? ""
          : ` It moves to ${channelName(otherChannel)} releases; the node backs up its database first (\`ryco db list\`).`;
      const confirmed = yield* options.confirm(
        `Update ${label} from ${before.currentVersion} to ${targetVersion}? The node restarts.${switching}`,
      );
      if (!confirmed) return yield* fail("Update cancelled.");
    }

    if (!options.json) {
      yield* Console.log(`Updating ${label}: ${before.currentVersion} -> ${targetVersion}`);
    }
    // Asked once, never again on a dropped connection: the node may already be running this
    // update, and following it by request id tells how it went either way.
    const started = yield* Effect.exit(
      Effect.scoped(
        Effect.flatMap(options.target.connect, (client) =>
          client[WS_METHODS.serverUpdateNode]({
            targetVersion,
            requestId: options.requestId,
            ...(otherChannel === null ? {} : { channel: otherChannel }),
          }),
        ),
      ),
    );
    if (Exit.isFailure(started) && !isConnectionLoss(started.cause)) {
      return yield* Effect.failCause(started.cause);
    }
    const after = yield* followRun(options);
    if (options.json) yield* Console.log(JSON.stringify(after));
    if (after.run.status === "failed") {
      return yield* fail(
        [
          `The update to ${targetVersion} failed: ${after.run.message ?? "no reason given"}.`,
          `${capitalized(label)} runs ${after.currentVersion}.`,
          ...(after.run.output === null ? [] : ["", after.run.output.trimEnd()]),
        ].join("\n"),
      );
    }
    if (after.run.status === "postponed") {
      return yield* fail(
        `Someone at that machine postponed the restart into ${targetVersion}; ${label} runs ${after.currentVersion} until it relaunches.`,
      );
    }
    if (!options.json) yield* Console.log(`Updated ${label} to ${after.currentVersion}.`);
    return after;
  });
