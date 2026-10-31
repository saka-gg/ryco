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
import { Console, Duration, Effect, Option, Stream } from "effect";
import { FetchHttpClient } from "effect/http";

import { CliRemoteError } from "../cliRemote/remotes.ts";
import { RYCO_CLI_PACKAGE } from "../nodeUpdate/installation.ts";
import { fetchNpmDistTagVersion } from "../npmRegistry.ts";
import {
  ThreadCliError,
  type ThreadCliTarget,
  withThreadConnection,
} from "../cliThread/threadCommands.ts";

/** How long the command follows a run, restart included. */
const FOLLOW_TIMEOUT = Duration.minutes(10);

const TERMINAL_STATUSES: ReadonlySet<NodeUpdateRun["status"]> = new Set(["succeeded", "failed"]);

const STATUS_LINES: Partial<Record<NodeUpdateRun["status"], (run: NodeUpdateRun) => string>> = {
  preparing: (run) => `Installing ${run.targetVersion ?? "the release"}…`,
  verifying: () => "Checking the new release against a copy of the database…",
  restarting: () => "Restarting the node…",
};

export interface UpdateCliOptions<R = never> {
  readonly target: ThreadCliTarget;
  /** "This node" or the remote's name, for messages. */
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

/** `ryco update --check`: where the node stands, without changing anything. */
export const runUpdateCheck = (input: {
  readonly target: ThreadCliTarget;
  readonly nodeLabel: string;
  readonly json: boolean;
}) =>
  Effect.gen(function* () {
    const state = yield* readState(input.target);
    yield* Console.log(
      input.json
        ? JSON.stringify(state)
        : [
            `${input.nodeLabel} runs ${state.currentVersion} (${state.channel}).`,
            state.latestVersion === null
              ? "The newest release is not known yet."
              : `Newest ${state.channel} release: ${state.latestVersion}.`,
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

const readState = (target: ThreadCliTarget) =>
  withThreadConnection(target, (client) => client[WS_METHODS.serverCheckNodeUpdate]({}));

/**
 * Follows the node's update state until the run with `requestId` ends. The node restarts in
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
  return withThreadConnection(options.target, (client) =>
    client[WS_METHODS.serverSubscribeNodeUpdate]({}).pipe(
      Stream.tap(report),
      Stream.filter(
        (state) =>
          state.run.requestId === options.requestId && TERMINAL_STATUSES.has(state.run.status),
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
      duration: options.followTimeout ?? FOLLOW_TIMEOUT,
      orElse: () =>
        fail(
          `The node did not report how the update ended within ${Duration.format(options.followTimeout ?? FOLLOW_TIMEOUT)}. Check it with \`ryco update --check\`.`,
        ),
    }),
  );
};

export const runUpdateCli = <R>(options: UpdateCliOptions<R>) =>
  Effect.gen(function* () {
    const before = yield* readState(options.target);
    if (!before.canUpdate) {
      return yield* fail(
        [
          before.manualReason ?? `${options.nodeLabel} cannot update itself.`,
          ...(before.manualCommand === null ? [] : [`Run: ${before.manualCommand}`]),
        ].join("\n"),
      );
    }
    if (
      before.run.status !== "idle" &&
      !TERMINAL_STATUSES.has(before.run.status) &&
      before.run.status !== "postponed"
    ) {
      return yield* fail(`An update is already running on ${options.nodeLabel}.`);
    }

    const otherChannel =
      options.channel !== null && options.channel !== before.channel ? options.channel : null;
    if (otherChannel === null && before.availability === "current") {
      yield* Console.log(
        options.json
          ? JSON.stringify(before)
          : `${options.nodeLabel} runs ${before.currentVersion}, the newest ${before.channel} release.`,
      );
      return before;
    }
    const targetVersion =
      otherChannel === null
        ? before.latestVersion
        : yield* options.fetchLatestOnChannel(otherChannel);
    if (targetVersion === null) {
      return yield* fail(
        `Could not find the newest ${otherChannel ?? before.channel} release. Try again.`,
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
          : ` It moves to the ${otherChannel} channel; the node backs up its database first (\`ryco db list\`), and a channel switch never goes back to an older release.`;
      const confirmed = yield* options.confirm(
        `Update ${options.nodeLabel} from ${before.currentVersion} to ${targetVersion}? The node restarts.${switching}`,
      );
      if (!confirmed) return yield* fail("Update cancelled.");
    }

    if (!options.json) {
      yield* Console.log(
        `Updating ${options.nodeLabel}: ${before.currentVersion} -> ${targetVersion}`,
      );
    }
    yield* withThreadConnection(options.target, (client) =>
      client[WS_METHODS.serverUpdateNode]({
        targetVersion,
        requestId: options.requestId,
        ...(otherChannel === null ? {} : { channel: otherChannel }),
      }),
    );
    const after = yield* followRun(options);
    if (options.json) yield* Console.log(JSON.stringify(after));
    if (after.run.status === "failed") {
      return yield* fail(
        [
          `The update to ${targetVersion} failed: ${after.run.message ?? "no reason given"}.`,
          `${options.nodeLabel} runs ${after.currentVersion}.`,
          ...(after.run.output === null ? [] : ["", after.run.output.trimEnd()]),
        ].join("\n"),
      );
    }
    if (!options.json)
      yield* Console.log(`Updated ${options.nodeLabel} to ${after.currentVersion}.`);
    return after;
  });
