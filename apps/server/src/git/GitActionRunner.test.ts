import * as NodeServices from "@effect/platform-node/NodeServices";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assert, expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  type GitActionProgressEvent,
  GitCommandError,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
} from "@ryco/contracts";
import { Deferred, Duration, Effect, Exit, Fiber, Layer, PubSub, Scope, Stream } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import { ServerConfig } from "../config.ts";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore.ts";
import { SessionCredentialServiceLive } from "../auth/Layers/SessionCredentialService.ts";
import {
  type SessionCredentialChange,
  SessionCredentialService,
  type SessionCredentialServiceShape,
} from "../auth/Services/SessionCredentialService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { hasWorktreeCreationLease } from "../storage/lifecycle.ts";
import {
  directPairingOwnerKey,
  directRpcPrincipal,
  rpcPrincipalOwnerKey,
} from "../ws/RpcPrincipal.ts";
import {
  GIT_ACTION_RECEIPTS_TO_KEEP,
  GitActionRunner,
  GitActionRunnerLive,
  type GitActionPublish,
  type GitActionRunnerShape,
} from "./GitActionRunner.ts";
import { makeGitActionRunner } from "./gitActionRunnerCore.ts";

const owner = "direct:session-a";

const command = (overrides?: Partial<GitRunStackedActionInput>): GitRunStackedActionInput => ({
  actionId: crypto.randomUUID(),
  cwd: "/repo",
  action: "push",
  recoverable: true,
  ...overrides,
});

const pushed = (action: GitRunStackedActionInput["action"]): GitRunStackedActionResult => ({
  action,
  branch: { status: "skipped_not_requested" },
  commit: { status: "skipped_not_requested" },
  push: { status: "pushed", branch: "feature/demo" },
  pr: { status: "skipped_not_requested" },
  toast: { title: "Pushed feature/demo", cta: { kind: "none" } },
});

const progress = (input: GitRunStackedActionInput) => {
  const base = { actionId: input.actionId, cwd: input.cwd, action: input.action };
  return {
    started: (): GitActionProgressEvent => ({
      ...base,
      kind: "action_started",
      phases: ["push"],
    }),
    phase: (phase: "branch" | "commit" | "push" | "pr"): GitActionProgressEvent => ({
      ...base,
      kind: "phase_started",
      phase,
      label: `${phase}...`,
    }),
    hookStarted: (): GitActionProgressEvent => ({
      ...base,
      kind: "hook_started",
      hookName: "pre-commit",
    }),
    hookOutput: (text: string): GitActionProgressEvent => ({
      ...base,
      kind: "hook_output",
      hookName: "pre-commit",
      stream: "stdout",
      text,
    }),
    finished: (): GitActionProgressEvent => ({
      ...base,
      kind: "action_finished",
      result: pushed(input.action),
    }),
  };
};

/** A push that reports its start and phase, then waits for `release`. */
const makeHeldPush = Effect.gen(function* () {
  const release = yield* Deferred.make<void>();
  const waiting = yield* Deferred.make<void>();
  const interrupted = yield* Deferred.make<void>();
  const state = { runs: 0 };
  const run =
    (input: GitRunStackedActionInput) =>
    (publish: GitActionPublish): Effect.Effect<void, GitCommandError> =>
      Effect.gen(function* () {
        state.runs += 1;
        const events = progress(input);
        yield* publish(events.started());
        yield* publish(events.phase("push"));
        yield* Deferred.succeed(waiting, undefined);
        yield* Deferred.await(release);
        yield* publish(events.finished());
      }).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)));
  return { release, waiting, interrupted, state, run };
});

const collect = <E>(stream: Stream.Stream<GitActionProgressEvent, E>) =>
  stream.pipe(
    Stream.runCollect,
    Effect.map((events) => [...events]),
  );

const kinds = (events: ReadonlyArray<GitActionProgressEvent>) => events.map((event) => event.kind);

/** Follows a stream in the background; `attached` completes with its first event. */
const follow = <E>(stream: Stream.Stream<GitActionProgressEvent, E>) =>
  Effect.gen(function* () {
    const events: GitActionProgressEvent[] = [];
    const attached = yield* Deferred.make<void>();
    const fiber = yield* stream.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => void events.push(event)).pipe(
          Effect.andThen(Deferred.succeed(attached, undefined)),
        ),
      ),
      Effect.forkScoped,
    );
    return { events, attached, fiber };
  });

const withRunner = <A, E>(f: (runner: GitActionRunnerShape) => Effect.Effect<A, E, Scope.Scope>) =>
  Effect.scoped(Effect.flatMap(makeGitActionRunner, f));

it.layer(NodeServices.layer)("GitActionRunner", (it) => {
  it.effect("keeps running when its observer leaves and replays its progress to a resume", () =>
    withRunner((runner) =>
      Effect.gen(function* () {
        const push = yield* makeHeldPush;
        const input = command();
        // The starting observer leaves after the phase: the connection dropped.
        const first = yield* collect(
          runner.start({ owner, command: input, run: push.run(input) }).pipe(Stream.take(2)),
        );
        expect(kinds(first)).toEqual(["action_started", "phase_started"]);
        yield* Deferred.await(push.waiting);

        const resumed = yield* follow(runner.resume({ owner, command: input }));
        yield* Deferred.await(resumed.attached);
        yield* Deferred.succeed(push.release, undefined);
        yield* Fiber.join(resumed.fiber);
        expect(kinds(resumed.events)).toEqual([
          "action_started",
          "phase_started",
          "action_finished",
        ]);
        expect(push.state.runs).toBe(1);
        expect(yield* Deferred.isDone(push.interrupted)).toBe(false);
      }),
    ),
  );

  it.effect("replays only the structural steps and the latest event after missed output", () =>
    withRunner((runner) =>
      Effect.gen(function* () {
        const input = command({ action: "commit_push" });
        const events = progress(input);
        const published = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const run = (publish: GitActionPublish) =>
          Effect.gen(function* () {
            yield* publish(events.started());
            yield* publish(events.phase("branch"));
            yield* publish(events.phase("commit"));
            yield* publish(events.hookStarted());
            for (let line = 0; line < 150; line += 1) {
              yield* publish(events.hookOutput(`line ${line}`));
            }
            yield* Deferred.succeed(published, undefined);
            yield* Deferred.await(release);
          });
        yield* collect(runner.start({ owner, command: input, run }).pipe(Stream.take(1)));
        yield* Deferred.await(published);

        const replay = yield* collect(
          runner.resume({ owner, command: input }).pipe(Stream.take(4)),
        );
        expect(replay).toEqual([
          events.started(),
          events.phase("commit"),
          events.hookStarted(),
          events.hookOutput("line 149"),
        ]);
        yield* Deferred.succeed(release, undefined);
      }),
    ),
  );

  it.effect("reports a missing receipt as unavailable and then refuses to start that id", () =>
    withRunner((runner) =>
      Effect.gen(function* () {
        const input = command();
        const missing = yield* Effect.flip(collect(runner.resume({ owner, command: input })));
        expect(missing).toMatchObject({
          _tag: "GitActionResultUnavailableError",
          actionId: input.actionId,
          reason: "missing",
        });
        expect(missing.message).toContain("Check the repository status");

        // The start arrives after its resume already told the client "unavailable".
        let runs = 0;
        const refused = yield* Effect.flip(
          collect(
            runner.start({
              owner,
              command: input,
              run: () => Effect.sync(() => void (runs += 1)),
            }),
          ),
        );
        expect(refused).toMatchObject({ _tag: "GitManagerError" });
        expect(refused.message).toContain("already reported as unavailable");
        expect(runs).toBe(0);
      }),
    ),
  );

  it.effect("keeps owners apart, refuses a reused id and attaches a repeated start", () =>
    withRunner((runner) =>
      Effect.gen(function* () {
        const push = yield* makeHeldPush;
        const input = command();
        const first = yield* collect(
          runner.start({ owner, command: input, run: push.run(input) }),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(push.waiting);

        // Another owner cannot see it, even with the id.
        const foreign = yield* Effect.flip(
          collect(runner.resume({ owner: "direct:session-b", command: input })),
        );
        expect(foreign).toMatchObject({ _tag: "GitActionResultUnavailableError" });
        // The same id for a different action.
        const reused = yield* Effect.flip(
          collect(runner.resume({ owner, command: { ...input, action: "commit_push" } })),
        );
        expect(reused.message).toContain("already used for a different Git action");
        // The same start again (a retried send): it follows the running action.
        const repeated = yield* follow(
          runner.start({ owner, command: input, run: push.run(input) }),
        );
        yield* Deferred.await(repeated.attached);
        yield* Deferred.succeed(push.release, undefined);

        expect(kinds(yield* Fiber.join(first)).at(-1)).toBe("action_finished");
        yield* Fiber.join(repeated.fiber);
        expect(kinds(repeated.events)).toEqual([
          "action_started",
          "phase_started",
          "action_finished",
        ]);
        expect(push.state.runs).toBe(1);
      }),
    ),
  );

  it.effect("refuses an action id that is not a random UUID", () =>
    withRunner((runner) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          collect(
            runner.start({
              owner,
              command: command({ actionId: "action-1" }),
              run: () => Effect.void,
            }),
          ),
        );
        expect(error.message).toContain("needs a random action id");
      }),
    ),
  );

  it.effect("refuses a second action in the same checkout while one runs", () =>
    withRunner((runner) =>
      Effect.gen(function* () {
        const push = yield* makeHeldPush;
        const input = command();
        const running = yield* collect(
          runner.start({ owner, command: input, run: push.run(input) }),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(push.waiting);

        const busy = yield* Effect.flip(
          collect(
            runner.start({
              owner: "direct:session-b",
              command: command({ action: "commit" }),
              run: () => Effect.void,
            }),
          ),
        );
        expect(busy.message).toBe(
          "Git manager failed in git.runStackedAction: A push is already running in this checkout. Wait for it to finish or stop it first.",
        );
        // Another spelling of the same checkout.
        const respelled = yield* Effect.flip(
          collect(
            runner.start({
              owner: "direct:session-b",
              command: command({ cwd: "/repo/./" }),
              run: () => Effect.void,
            }),
          ),
        );
        expect(respelled.message).toContain("A push is already running in this checkout");
        // Another checkout is not held up.
        yield* collect(
          runner.start({ owner, command: command({ cwd: "/other" }), run: () => Effect.void }),
        );

        yield* Deferred.succeed(push.release, undefined);
        yield* Fiber.join(running);
        yield* collect(runner.start({ owner, command: command(), run: () => Effect.void }));
      }),
    ),
  );

  it.effect("keeps the newest receipts, ages settled ones out and never drops a running one", () =>
    withRunner((runner) =>
      Effect.gen(function* () {
        const push = yield* makeHeldPush;
        const longRunning = command({ cwd: "/long" });
        yield* collect(
          runner
            .start({ owner, command: longRunning, run: push.run(longRunning) })
            .pipe(Stream.take(1)),
        );
        yield* TestClock.adjust(Duration.hours(2));

        const settled = Array.from({ length: 300 }, () => command());
        for (const input of settled) {
          yield* collect(runner.start({ owner, command: input, run: () => Effect.void }));
        }
        // The oldest kept one replays its end; the one before it was dropped.
        const oldestKept = yield* collect(
          runner.resume({ owner, command: settled[300 - GIT_ACTION_RECEIPTS_TO_KEEP]! }),
        );
        expect(oldestKept).toEqual([]);
        const evicted = yield* Effect.flip(
          collect(
            runner.resume({ owner, command: settled[300 - GIT_ACTION_RECEIPTS_TO_KEEP - 1]! }),
          ),
        );
        expect(evicted).toMatchObject({ reason: "missing" });

        yield* TestClock.adjust(Duration.minutes(31));
        const aged = yield* Effect.flip(
          collect(runner.resume({ owner, command: settled.at(-1)! })),
        );
        expect(aged).toMatchObject({ reason: "missing" });

        // Started two and a half hours ago and still running: still there.
        const still = yield* collect(
          runner.resume({ owner, command: longRunning }).pipe(Stream.take(2)),
        );
        expect(kinds(still)).toEqual(["action_started", "phase_started"]);
        yield* Deferred.succeed(push.release, undefined);
      }),
    ),
  );

  it.effect("keeps resume misses within their own bound, apart from the receipts", () =>
    withRunner((runner) =>
      Effect.gen(function* () {
        const finished = command();
        yield* collect(runner.start({ owner, command: finished, run: () => Effect.void }));
        const first = command();
        yield* Effect.flip(collect(runner.resume({ owner, command: first })));
        for (let index = 0; index < GIT_ACTION_RECEIPTS_TO_KEEP + 44; index += 1) {
          yield* Effect.flip(collect(runner.resume({ owner, command: command() })));
        }
        // The first miss was dropped with the oldest: its id may start again.
        yield* collect(runner.start({ owner, command: first, run: () => Effect.void }));
        // The misses never pushed out an action's receipt.
        expect(yield* collect(runner.resume({ owner, command: finished }))).toEqual([]);
      }),
    ),
  );

  it.effect("stops a running action on request and keeps the stop as its outcome", () =>
    withRunner((runner) =>
      Effect.gen(function* () {
        const push = yield* makeHeldPush;
        const input = command();
        const observed = yield* collect(
          runner.start({ owner, command: input, run: push.run(input) }),
        ).pipe(Effect.exit, Effect.forkScoped);
        yield* Deferred.await(push.waiting);

        expect(yield* runner.cancel({ owner: "direct:session-b", actionId: input.actionId })).toBe(
          false,
        );
        expect(yield* runner.cancel({ owner, actionId: crypto.randomUUID() })).toBe(false);
        expect(yield* runner.cancel({ owner, actionId: input.actionId })).toBe(true);
        yield* Deferred.await(push.interrupted);

        const exit = yield* Fiber.join(observed);
        assert.isTrue(Exit.isFailure(exit));
        const stopped = yield* Effect.flip(collect(runner.resume({ owner, command: input })));
        expect(stopped).toMatchObject({
          _tag: "GitActionStoppedError",
          actionId: input.actionId,
          phase: "push",
          reason: "requested",
        });
        // The resume replays the synthesized end before the stop.
        const replay: GitActionProgressEvent[] = [];
        yield* runner.resume({ owner, command: input }).pipe(
          Stream.runForEach((event) => Effect.sync(() => void replay.push(event))),
          Effect.ignore,
        );
        expect(replay).toEqual([
          {
            actionId: input.actionId,
            cwd: input.cwd,
            action: input.action,
            kind: "action_failed",
            phase: "push",
            message: "Stopped.",
          },
        ]);
        expect(yield* runner.cancel({ owner, actionId: input.actionId })).toBe(false);
      }),
    ),
  );

  it.effect("refuses Stop once the action reported its result, which stands", () =>
    withRunner((runner) =>
      Effect.gen(function* () {
        const input = command();
        const reported = yield* Deferred.make<void>();
        const bookkeeping = yield* Deferred.make<void>();
        const run = (publish: GitActionPublish) =>
          Effect.gen(function* () {
            yield* publish(progress(input).started());
            yield* publish(progress(input).finished());
            yield* Deferred.succeed(reported, undefined);
            // The pull request link and the status refresh still run.
            yield* Deferred.await(bookkeeping);
          });
        const observed = yield* collect(runner.start({ owner, command: input, run })).pipe(
          Effect.forkScoped,
        );
        yield* Deferred.await(reported);

        expect(yield* runner.cancel({ owner, actionId: input.actionId })).toBe(false);
        expect(yield* runner.stopOwner(owner, "access-revoked")).toBe(0);
        yield* Deferred.succeed(bookkeeping, undefined);
        expect(kinds(yield* Fiber.join(observed))).toEqual(["action_started", "action_finished"]);
        expect(kinds(yield* collect(runner.resume({ owner, command: input })))).toEqual([
          "action_finished",
        ]);
      }),
    ),
  );

  it.effect("keeps the failure an action reported when a Stop raced its end", () =>
    withRunner((runner) =>
      Effect.gen(function* () {
        const input = command();
        const waiting = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const failure = new GitCommandError({
          operation: "push",
          command: "git push",
          cwd: input.cwd,
          detail: "rejected",
        });
        const run = (publish: GitActionPublish) =>
          Effect.gen(function* () {
            yield* publish(progress(input).started());
            yield* Deferred.succeed(waiting, undefined);
            // The Stop's interrupt is held off until the action reported its failure, then
            // lands before the error is raised (the fiber yielded in between).
            yield* Effect.uninterruptible(
              Deferred.await(release).pipe(
                Effect.andThen(
                  publish({
                    actionId: input.actionId,
                    cwd: input.cwd,
                    action: input.action,
                    kind: "action_failed",
                    phase: "push",
                    message: failure.message,
                  }),
                ),
              ),
            );
            return yield* failure;
          });
        const events: GitActionProgressEvent[] = [];
        const observed = yield* runner.start({ owner, command: input, run }).pipe(
          Stream.runForEach((event) => Effect.sync(() => void events.push(event))),
          Effect.flip,
          Effect.forkScoped,
        );
        yield* Deferred.await(waiting);
        expect(yield* runner.cancel({ owner, actionId: input.actionId })).toBe(true);
        // The forked interrupt reaches the run before it is released.
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);

        const error = yield* Fiber.join(observed);
        expect(error).toMatchObject({ _tag: "GitManagerError" });
        expect(error.message).toContain(failure.message);
        // One end, the action's own: no "Stopped." after it.
        expect(kinds(events)).toEqual(["action_started", "action_failed"]);
      }),
    ),
  );

  it.effect("refuses a start of a revoked owner that arrives after the revocation", () =>
    withRunner((runner) =>
      Effect.gen(function* () {
        expect(yield* runner.stopOwner(owner, "access-revoked")).toBe(0);
        let runs = 0;
        const refused = yield* Effect.flip(
          collect(
            runner.start({
              owner,
              command: command(),
              run: () => Effect.sync(() => void (runs += 1)),
            }),
          ),
        );
        expect(refused.message).toContain("Access to this machine was revoked");
        expect(runs).toBe(0);
        // Other owners are not affected.
        yield* collect(
          runner.start({ owner: "direct:session-b", command: command(), run: () => Effect.void }),
        );
      }),
    ),
  );

  it.effect("replays a failure's final event and fails a resume with the same error", () =>
    withRunner((runner) =>
      Effect.gen(function* () {
        const input = command();
        const failure = new GitCommandError({
          operation: "push",
          command: "git push",
          cwd: input.cwd,
          detail: "rejected",
        });
        const run = (publish: GitActionPublish) =>
          publish({
            actionId: input.actionId,
            cwd: input.cwd,
            action: input.action,
            kind: "action_failed",
            phase: "push",
            message: failure.message,
          }).pipe(Effect.andThen(Effect.fail(failure)));
        yield* Effect.flip(collect(runner.start({ owner, command: input, run })));

        const events: GitActionProgressEvent[] = [];
        const error = yield* Effect.flip(
          runner
            .resume({ owner, command: input })
            .pipe(Stream.runForEach((event) => Effect.sync(() => void events.push(event)))),
        );
        expect(error).toEqual(failure);
        expect(kinds(events)).toEqual(["action_failed"]);
      }),
    ),
  );

  it.effect("interrupts running actions when its scope closes (server shutdown)", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const runner = yield* makeGitActionRunner.pipe(Scope.provide(scope));
      const push = yield* makeHeldPush;
      const input = command();
      yield* collect(
        runner.start({ owner, command: input, run: push.run(input) }).pipe(Stream.take(1)),
      );
      yield* Deferred.await(push.waiting);
      yield* Scope.close(scope, Exit.void);
      yield* Deferred.await(push.interrupted);
    }),
  );

  it.effect("stops only the revoked owner's actions", () =>
    withRunner((runner) =>
      Effect.gen(function* () {
        const mine = yield* makeHeldPush;
        const theirs = yield* makeHeldPush;
        const mineInput = command({ cwd: "/mine" });
        const theirsInput = command({ cwd: "/theirs" });
        const mineExit = yield* collect(
          runner.start({ owner, command: mineInput, run: mine.run(mineInput) }),
        ).pipe(Effect.exit, Effect.forkScoped);
        yield* collect(
          runner
            .start({
              owner: "direct:session-b",
              command: theirsInput,
              run: theirs.run(theirsInput),
            })
            .pipe(Stream.take(1)),
        );
        yield* Deferred.await(mine.waiting);
        yield* Deferred.await(theirs.waiting);

        expect(yield* runner.stopOwner(owner, "access-revoked")).toBe(1);
        assert.isTrue(Exit.isFailure(yield* Fiber.join(mineExit)));
        const stopped = yield* Effect.flip(collect(runner.resume({ owner, command: mineInput })));
        expect(stopped).toMatchObject({ _tag: "GitActionStoppedError", reason: "access-revoked" });
        expect(yield* Deferred.isDone(theirs.interrupted)).toBe(false);
        yield* Deferred.succeed(theirs.release, undefined);
      }),
    ),
  );

  it.effect("never lets a slow observer hold up the work", () =>
    withRunner((runner) =>
      Effect.gen(function* () {
        const input = command();
        const events = progress(input);
        const done = yield* Deferred.make<void>();
        const run = (publish: GitActionPublish) =>
          Effect.gen(function* () {
            yield* publish(events.started());
            yield* publish(events.phase("commit"));
            yield* publish(events.hookStarted());
            for (let line = 0; line < 1_000; line += 1) {
              yield* publish(events.hookOutput(`line ${line}`));
            }
            yield* Deferred.succeed(done, undefined);
          });
        const stuck = yield* Deferred.make<void>();
        // Takes the first event, then never pulls again.
        yield* runner.start({ owner, command: input, run }).pipe(
          Stream.runForEach(() => Deferred.await(stuck)),
          Effect.forkScoped,
        );
        yield* Deferred.await(done);
      }),
    ),
  );

  it.effect("holds the checkout against storage cleanup while the action runs", () =>
    Effect.gen(function* () {
      const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "ryco-git-action-lease-")));
      yield* withRunner((runner) =>
        Effect.gen(function* () {
          const push = yield* makeHeldPush;
          const input = command({ cwd });
          const observed = yield* collect(
            runner.start({ owner, command: input, run: push.run(input) }),
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(push.waiting);
          expect(hasWorktreeCreationLease(cwd)).toBe(true);
          yield* Deferred.succeed(push.release, undefined);
          yield* Fiber.join(observed);
          expect(hasWorktreeCreationLease(cwd)).toBe(false);
        }),
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("says why it cannot hold the checkout", () =>
    Effect.gen(function* () {
      const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "ryco-git-action-removed-")));
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO storage_owned_entries (id, path, category, identity_json, created_at, state) VALUES ('git-action-guard', ${cwd}, 'worktree', '{}', ${new Date().toISOString()}, 'removed')`;
      yield* withRunner((runner) =>
        Effect.gen(function* () {
          const removed = yield* Effect.flip(
            collect(runner.start({ owner, command: command({ cwd }), run: () => Effect.void })),
          );
          expect(removed.message).toContain("This checkout is being cleaned up or was removed");
          // Not a refusal: the path itself could not be checked.
          const unchecked = yield* Effect.flip(
            collect(
              runner.start({
                owner,
                command: command({ cwd: "/tmp/invalid\u0000path" }),
                run: () => Effect.void,
              }),
            ),
          );
          expect(unchecked.message).toContain("Couldn't check the checkout");
        }),
      );
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});

/** A session service that only announces changes the test publishes. */
const makeAnnouncingSessions = Effect.gen(function* () {
  const changes = yield* PubSub.unbounded<SessionCredentialChange>();
  const service = {
    get streamChanges() {
      return Stream.fromPubSub(changes);
    },
  } as unknown as SessionCredentialServiceShape;
  return { changes, layer: Layer.succeed(SessionCredentialService, service) };
});

it.layer(NodeServices.layer)("GitActionRunnerLive", (it) => {
  it.effect("stops a pairing's actions when it is revoked, never when it is renewed", () =>
    Effect.gen(function* () {
      const sessions = yield* makeAnnouncingSessions;
      yield* Effect.gen(function* () {
        const runner = yield* GitActionRunner;
        const push = yield* makeHeldPush;
        const input = command();
        const pairingOwner = directPairingOwnerKey("chain-a");
        yield* collect(
          runner
            .start({ owner: pairingOwner, command: input, run: push.run(input) })
            .pipe(Stream.take(1)),
        );
        yield* Deferred.await(push.waiting);

        yield* PubSub.publish(sessions.changes, {
          type: "clientRemoved",
          sessionId: AuthSessionId.make("session-a"),
          chainId: AuthSessionId.make("chain-a"),
          reason: "superseded",
        });
        yield* Effect.yieldNow;
        expect(yield* Deferred.isDone(push.interrupted)).toBe(false);

        yield* PubSub.publish(sessions.changes, {
          type: "clientRemoved",
          sessionId: AuthSessionId.make("session-b"),
          chainId: AuthSessionId.make("chain-a"),
          reason: "revoked",
        });
        yield* Deferred.await(push.interrupted);
        const stopped = yield* Effect.flip(
          collect(runner.resume({ owner: pairingOwner, command: input })),
        );
        expect(stopped).toMatchObject({ _tag: "GitActionStoppedError", reason: "access-revoked" });
      }).pipe(Effect.provide(GitActionRunnerLive.pipe(Layer.provide(sessions.layer))));
    }),
  );

  it.effect("remembers a revocation that came before the runner loaded", () =>
    Effect.gen(function* () {
      const runner = yield* GitActionRunner;
      const pairingOwner = directPairingOwnerKey("chain-revoked");
      // Nothing ran yet, so nothing stops; a start already on its way must still not run.
      expect(yield* runner.stopOwner(pairingOwner, "access-revoked")).toBe(0);
      let runs = 0;
      const refused = yield* Effect.flip(
        collect(
          runner.start({
            owner: pairingOwner,
            command: command(),
            run: () => Effect.sync(() => void (runs += 1)),
          }),
        ),
      );
      expect(refused.message).toContain("Access to this machine was revoked");
      expect(runs).toBe(0);
    }).pipe(Effect.provide(GitActionRunnerLive)),
  );

  it.effect(
    "follows an action across a bearer renewal and stops it when the pairing is revoked",
    () =>
      Effect.gen(function* () {
        const credentials = yield* SessionCredentialService;
        const runner = yield* GitActionRunner;
        const ownerOf = (verified: {
          readonly sessionId: AuthSessionId;
          readonly chainId: AuthSessionId;
        }) =>
          rpcPrincipalOwnerKey(
            directRpcPrincipal({
              sessionId: verified.sessionId,
              chainId: verified.chainId,
              subject: "one-time-token",
              method: "bearer-session-token",
              role: "client",
            }),
          );

        const paired = yield* credentials.issue({
          method: "bearer-session-token",
          subject: "one-time-token",
        });
        const before = yield* credentials.verify(paired.token);
        const push = yield* makeHeldPush;
        const input = command();
        yield* collect(
          runner
            .start({ owner: ownerOf(before), command: input, run: push.run(input) })
            .pipe(Stream.take(1)),
        );
        yield* Deferred.await(push.waiting);

        // The client renews its bearer mid-push; the successor's first use supersedes the
        // session the push started under.
        yield* TestClock.adjust(Duration.days(2));
        const renewed = yield* credentials.rotate(paired.sessionId);
        const after = yield* credentials.verify(renewed.token);
        expect(after.sessionId).not.toBe(before.sessionId);
        expect(ownerOf(after)).toBe(ownerOf(before));
        yield* Effect.yieldNow;
        expect(yield* Deferred.isDone(push.interrupted)).toBe(false);

        const resumed = yield* collect(
          runner.resume({ owner: ownerOf(after), command: input }).pipe(Stream.take(2)),
        );
        expect(kinds(resumed)).toEqual(["action_started", "phase_started"]);

        expect(yield* credentials.revoke(renewed.sessionId)).toBe(true);
        yield* Deferred.await(push.interrupted);
        const stopped = yield* Effect.flip(
          collect(runner.resume({ owner: ownerOf(after), command: input })),
        );
        expect(stopped).toMatchObject({ _tag: "GitActionStoppedError", reason: "access-revoked" });
      }).pipe(
        Effect.provide(
          GitActionRunnerLive.pipe(
            Layer.provideMerge(
              SessionCredentialServiceLive.pipe(
                Layer.provide(SqlitePersistenceMemory),
                Layer.provide(ServerSecretStoreLive),
                Layer.provide(
                  ServerConfig.layerTest(process.cwd(), { prefix: "ryco-git-action-runner-test-" }),
                ),
              ),
            ),
          ),
        ),
      ),
  );
});
