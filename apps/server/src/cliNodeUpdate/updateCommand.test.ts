import {
  type NodeUpdateInput,
  type NodeUpdateRun,
  type NodeUpdateState,
  WS_METHODS,
} from "@ryco/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Layer, Stream } from "effect";
import * as TestConsole from "effect/testing/TestConsole";

import { CliRemoteError, type CliRemoteRpcClient } from "../cliRemote/remotes.ts";
import type { ThreadCliTarget } from "../cliThread/threadCommands.ts";
import { runUpdateCheck, runUpdateCli, type UpdateCliOptions } from "./updateCommand.ts";

const idleRun: NodeUpdateRun = {
  status: "idle",
  requestId: null,
  fromVersion: null,
  targetVersion: null,
  startedAt: null,
  finishedAt: null,
  restartAt: null,
  progressPercent: null,
  message: null,
  output: null,
};

const state = (overrides: Partial<NodeUpdateState> = {}): NodeUpdateState => ({
  currentVersion: "0.1.36",
  latestVersion: "0.1.37",
  channel: "latest",
  availability: "behind_latest",
  installation: { kind: "npm-global", service: "launchd" },
  canUpdate: true,
  manualReason: null,
  manualCommand: null,
  checkedAt: "2026-10-31T05:00:00.000Z",
  ...overrides,
  run: overrides.run ?? idleRun,
});

const running = (status: NodeUpdateRun["status"], extra: Partial<NodeUpdateRun> = {}) =>
  state({
    run: {
      ...idleRun,
      status,
      requestId: "cli-1",
      fromVersion: "0.1.36",
      targetVersion: "0.1.37",
      ...extra,
    },
  });

/**
 * A node that answers `check`, records `update`, and streams its run: the first connection
 * drops after `restarting` (the node restarts), the next one reports how the run ended.
 */
const fakeNode = (input: {
  readonly before: NodeUpdateState;
  readonly after?: NodeUpdateState;
  /** The socket drops right after the node took the request. */
  readonly dropAfterUpdate?: boolean;
}) => {
  const updates: Array<NodeUpdateInput> = [];
  let connections = 0;
  let subscriptions = 0;
  const client = () =>
    ({
      [WS_METHODS.serverCheckNodeUpdate]: () => Effect.succeed(input.before),
      [WS_METHODS.serverUpdateNode]: (request: NodeUpdateInput) =>
        Effect.sync(() => {
          updates.push(request);
          return running("preparing");
        }).pipe(
          Effect.andThen(
            input.dropAfterUpdate === true
              ? Effect.fail(new CliRemoteError({ message: "socket closed" }))
              : Effect.succeed(running("preparing")),
          ),
        ),
      [WS_METHODS.serverSubscribeNodeUpdate]: () =>
        updates.length === 0
          ? Stream.make(input.before)
          : ++subscriptions === 1
            ? Stream.concat(
                Stream.make(running("preparing"), running("verifying"), running("restarting")),
                Stream.fail(new CliRemoteError({ message: "socket closed" })),
              )
            : Stream.make(input.after ?? input.before),
    }) as unknown as CliRemoteRpcClient;
  const target: ThreadCliTarget = {
    connect: Effect.sync(() => {
      connections += 1;
      return client();
    }),
    local: true,
  };
  return { target, updates, connections: () => connections };
};

const options = (
  target: ThreadCliTarget,
  overrides: Partial<UpdateCliOptions> = {},
): UpdateCliOptions => ({
  target,
  nodeLabel: "this node",
  channel: null,
  yes: true,
  json: false,
  interactive: false,
  confirm: () => Effect.succeed(true),
  fetchLatestOnChannel: () => Effect.succeed(null),
  requestId: "cli-1",
  ...overrides,
});

const withConsole = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(effect);
    const lines = (yield* TestConsole.logLines).filter(
      (line): line is string => typeof line === "string",
    );
    return { result, lines };
  }).pipe(Effect.provide(Layer.fresh(TestConsole.layer)));

describe("ryco update", () => {
  it.live("starts the node's own update and follows it across the restart", () =>
    Effect.gen(function* () {
      const node = fakeNode({
        before: state(),
        after: { ...running("succeeded"), currentVersion: "0.1.37", availability: "current" },
      });
      const { result, lines } = yield* withConsole(runUpdateCli(options(node.target)));
      assert.isTrue(result._tag === "Success");
      assert.deepEqual(node.updates, [{ targetVersion: "0.1.37", requestId: "cli-1" }]);
      assert.deepEqual(lines, [
        "Updating this node: 0.1.36 -> 0.1.37",
        "Installing 0.1.37…",
        "Checking the new release against a copy of the database…",
        "Restarting the node…",
        "Updated this node to 0.1.37.",
      ]);
      // It reconnected after the restart dropped the socket.
      assert.isAbove(node.connections(), 3);
    }),
  );

  it.live("reports a failed update with the node's reason and installer output", () =>
    Effect.gen(function* () {
      const node = fakeNode({
        before: state(),
        after: running("failed", { message: "the new release did not start", output: "npm ERR!" }),
      });
      const { result } = yield* withConsole(runUpdateCli(options(node.target)));
      assert.isTrue(result._tag === "Failure");
      const message = String((result as { cause: { failures?: unknown } }).cause);
      assert.include(message, "the new release did not start");
    }),
  );

  it.live("asks before restarting, and refuses without a terminal unless --yes", () =>
    Effect.gen(function* () {
      const quiet = fakeNode({ before: state() });
      const noTerminal = yield* withConsole(
        runUpdateCli(options(quiet.target, { yes: false, interactive: false })),
      );
      assert.isTrue(noTerminal.result._tag === "Failure");
      assert.deepEqual(quiet.updates, []);

      const declined = fakeNode({ before: state() });
      const asked: Array<string> = [];
      yield* withConsole(
        runUpdateCli(
          options(declined.target, {
            yes: false,
            interactive: true,
            confirm: (message) => Effect.sync(() => (asked.push(message), false)),
          }),
        ),
      );
      assert.deepEqual(declined.updates, []);
      assert.include(asked[0] ?? "", "from 0.1.36 to 0.1.37? The node restarts.");
    }),
  );

  it.live("moves to another channel through the node", () =>
    Effect.gen(function* () {
      const nightly = "0.1.37-nightly.20261101.4";
      const node = fakeNode({
        before: state({ latestVersion: "0.1.36", availability: "current" }),
        after: { ...running("succeeded", { targetVersion: nightly }), currentVersion: nightly },
      });
      yield* withConsole(
        runUpdateCli(
          options(node.target, {
            channel: "nightly",
            fetchLatestOnChannel: (channel) =>
              Effect.succeed(channel === "nightly" ? nightly : null),
          }),
        ),
      );
      assert.deepEqual(node.updates, [
        { targetVersion: nightly, requestId: "cli-1", channel: "nightly" },
      ]);
    }),
  );

  it.live("leaves a current node alone, and says how to update one that cannot itself", () =>
    Effect.gen(function* () {
      const current = fakeNode({
        before: state({ availability: "current", latestVersion: "0.1.36" }),
      });
      const upToDate = yield* withConsole(runUpdateCli(options(current.target)));
      assert.isTrue(upToDate.result._tag === "Success");
      assert.deepEqual(current.updates, []);
      assert.include(
        upToDate.lines.join("\n"),
        "This node runs 0.1.36, the newest stable release.",
      );

      const manual = fakeNode({
        before: state({
          canUpdate: false,
          manualReason: "Ryco runs in the foreground here, so it cannot restart itself.",
          manualCommand: "npm install -g ryco-cli@latest",
        }),
      });
      const refused = yield* withConsole(runUpdateCli(options(manual.target)));
      assert.isTrue(refused.result._tag === "Failure");
      assert.include(String(refused.result), "npm install -g ryco-cli@latest");
      assert.deepEqual(manual.updates, []);
    }),
  );

  it.live("asks the node once, and follows the run when the socket drops after the request", () =>
    Effect.gen(function* () {
      const node = fakeNode({
        before: state(),
        after: { ...running("succeeded"), currentVersion: "0.1.37" },
        dropAfterUpdate: true,
      });
      const { result } = yield* withConsole(runUpdateCli(options(node.target)));
      assert.isTrue(result._tag === "Success");
      // Never sent twice: the node may already be running it.
      assert.equal(node.updates.length, 1);
    }),
  );

  it.live("stops following when someone postpones the desktop app's relaunch", () =>
    Effect.gen(function* () {
      const node = fakeNode({ before: state(), after: running("postponed") });
      const { result } = yield* withConsole(
        runUpdateCli(options(node.target, { followTimeout: Duration.seconds(20) })),
      );
      assert.isTrue(result._tag === "Failure");
      assert.include(String(result), "postponed the restart");
    }),
  );

  it.live("refuses a channel switch that would go back, before asking", () =>
    Effect.gen(function* () {
      const node = fakeNode({
        before: state({
          currentVersion: "0.1.37-nightly.20261101.4",
          channel: "nightly",
          latestVersion: "0.1.37-nightly.20261101.4",
          availability: "current",
        }),
      });
      const asked: Array<string> = [];
      const { result } = yield* withConsole(
        runUpdateCli(
          options(node.target, {
            channel: "latest",
            yes: false,
            interactive: true,
            confirm: (message) => Effect.sync(() => (asked.push(message), true)),
            fetchLatestOnChannel: () => Effect.succeed("0.1.36"),
          }),
        ),
      );
      assert.isTrue(result._tag === "Failure");
      assert.include(String(result), "never goes back to an older release");
      assert.deepEqual(asked, []);
      assert.deepEqual(node.updates, []);
    }),
  );

  it.live("checks where a node stands with viewer access and without the registry", () =>
    Effect.gen(function* () {
      const node = fakeNode({
        before: state({
          run: {
            ...idleRun,
            status: "succeeded",
            targetVersion: "0.1.36",
            finishedAt: "2026-10-30T10:00:00.000Z",
          },
        }),
      });
      const { result, lines } = yield* withConsole(
        runUpdateCheck({
          target: node.target,
          nodeLabel: "this node",
          json: false,
          channel: "nightly",
          fetchLatestOnChannel: () => Effect.succeed("0.1.37-nightly.20261101.4"),
        }),
      );
      assert.isTrue(result._tag === "Success");
      assert.deepEqual(lines, [
        [
          "This node runs 0.1.36 (stable).",
          "Newest stable release: 0.1.37.",
          "Newest nightly release: 0.1.37-nightly.20261101.4.",
          "Last update, to 0.1.36 (2026-10-30T10:00:00.000Z): succeeded.",
        ].join("\n"),
      ]);
      assert.deepEqual(node.updates, []);
    }),
  );
});
