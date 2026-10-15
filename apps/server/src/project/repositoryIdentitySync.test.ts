import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type OrchestrationCommand,
  type OrchestrationEvent,
  ProjectId,
  type RepositoryIdentity,
} from "@ryco/contracts";
import { Deferred, Duration, Effect, Layer, Option, PubSub } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import { RepositoryIdentityProbeError } from "./Services/RepositoryIdentityResolver.ts";
import { type ProcessLane, ProcessLaneRef } from "../processGovernor.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  type ProjectionProject,
  ProjectionProjectRepository,
} from "../persistence/Services/ProjectionProjects.ts";
import {
  decodePersistedRepositoryIdentity,
  encodePersistedRepositoryIdentity,
  readRepositoryIdentityFingerprint,
} from "./repositoryIdentityPersistence.ts";
import {
  makeRepositoryIdentitySync,
  repositoryIdentityRetryDelay,
  repositoryIdentityTrigger,
  runRepositoryIdentitySync,
} from "./repositoryIdentitySync.ts";

const NOW = new Date("2026-10-12T12:00:00.000Z");
const CREATED = "2026-10-01T00:00:00.000Z";

const identity = (canonicalKey: string, rootPath: string): RepositoryIdentity => ({
  canonicalKey,
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: `https://${canonicalKey}.git`,
  },
  rootPath,
  remotes: [],
});

const project = (id: string, overrides: Partial<ProjectionProject> = {}): ProjectionProject => ({
  projectId: ProjectId.make(id),
  kind: "project",
  title: id,
  workspaceRoot: `/repos/${id}`,
  projectMetadataDir: ".ryco",
  defaultModelSelection: null,
  customAvatarContentHash: null,
  preferredRemoteName: null,
  scripts: [],
  createdAt: CREATED,
  updatedAt: CREATED,
  deletedAt: null,
  ...overrides,
});

/** Runs `body` against real projection tables with scripted git answers and fingerprints. */
const harness = <A>(input: {
  readonly projects: ReadonlyArray<ProjectionProject>;
  readonly identities: Map<string, RepositoryIdentity | null>;
  readonly fingerprints: Map<string, string | null>;
  /** Roots whose probe `git` cannot answer (timeout, spawn failure). */
  readonly failing?: Set<string>;
  readonly body: (context: {
    readonly sync: (projectId?: ProjectId) => Effect.Effect<{
      readonly checked: number;
      readonly resolved: number;
      readonly changed: number;
      readonly failed: number;
    }>;
    readonly probes: string[];
    /** The process lane each probe ran in. */
    readonly lanes: ProcessLane[];
    readonly commands: OrchestrationCommand[];
    readonly storedIdentity: (projectId: string) => Effect.Effect<RepositoryIdentity | null>;
    readonly setNow: (now: Date) => void;
    /** Consecutive-failure counts reported per failed probe, in order. */
    readonly failures: Array<readonly [string, number]>;
  }) => Effect.Effect<A, ProjectionRepositoryError, ProjectionProjectRepository>;
}) => {
  const failures: Array<readonly [string, number]> = [];
  const probes: string[] = [];
  const lanes: ProcessLane[] = [];
  const commands: OrchestrationCommand[] = [];
  let now = NOW;
  const program = Effect.gen(function* () {
    const projects = yield* ProjectionProjectRepository;
    for (const row of input.projects) yield* projects.upsert(row);
    const { sync } = yield* makeRepositoryIdentitySync({
      projects,
      resolver: {
        resolve: () => Effect.die("refresh must be preferred over resolve"),
        refresh: (cwd) =>
          Effect.flatMap(ProcessLaneRef, (lane) =>
            Effect.suspend(() => {
              probes.push(cwd);
              lanes.push(lane);
              return input.failing?.has(cwd) === true
                ? Effect.fail(
                    new RepositoryIdentityProbeError({
                      operation: "RepositoryIdentityResolver.showToplevel",
                      detail: "timed out",
                    }),
                  )
                : Effect.succeed(input.identities.get(cwd) ?? null);
            }),
          ),
      },
      onProbeFailed: (projectId, attempt) =>
        Effect.sync(() => {
          failures.push([projectId, attempt]);
        }),
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
      readFingerprint: (workspaceRoot) =>
        Effect.succeed(input.fingerprints.get(workspaceRoot) ?? null),
      now: () => now,
    });
    const storedIdentity = (projectId: string) =>
      projects.listRepositoryIdentityStates({ projectId: ProjectId.make(projectId) }).pipe(
        Effect.map(([state]) =>
          decodePersistedRepositoryIdentity(state?.repositoryIdentityJson ?? null),
        ),
        Effect.orDie,
      );
    return yield* input.body({
      sync,
      probes,
      lanes,
      commands,
      storedIdentity,
      setNow: (next) => {
        now = next;
      },
      failures,
    });
  }).pipe(
    Effect.provide(
      ProjectionProjectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ),
  );
  return Effect.runPromise(program);
};

describe("repository identity sync", () => {
  it("resolves each repository once, then only when its git config changes", async () => {
    const fingerprints = new Map<string, string | null>([
      ["/repos/a", "git:a|1"],
      ["/repos/b", "none"],
    ]);
    const identities = new Map([["/repos/a", identity("github.com/acme/a", "/repos/a")]]);
    await harness({
      projects: [project("a"), project("b")],
      identities,
      fingerprints,
      body: ({ sync, probes, lanes, commands, storedIdentity }) =>
        Effect.gen(function* () {
          const first = yield* sync();
          expect(first).toEqual({ checked: 2, resolved: 2, changed: 1, failed: 0 });
          expect(probes.toSorted()).toEqual(["/repos/a", "/repos/b"]);
          // Identity probes yield to interactive git under the process governor.
          expect(lanes).toEqual(["background", "background"]);
          expect((yield* storedIdentity("a"))?.canonicalKey).toBe("github.com/acme/a");
          expect(yield* storedIdentity("b")).toBeNull();
          // The identity appeared: one empty meta update re-sends the project to clients.
          expect(commands).toEqual([
            expect.objectContaining({ type: "project.meta.update", projectId: "a" }),
          ]);
          expect(Object.keys(commands[0]!).toSorted()).toEqual(["commandId", "projectId", "type"]);

          // Steady state: fingerprints unchanged, no git at all.
          probes.length = 0;
          expect(yield* sync()).toEqual({ checked: 2, resolved: 0, changed: 0, failed: 0 });
          expect(probes).toEqual([]);

          // The remote moved: config fingerprint changes, one probe, one announcement.
          fingerprints.set("/repos/a", "git:a|2");
          identities.set("/repos/a", identity("github.com/acme/renamed", "/repos/a"));
          expect(yield* sync(ProjectId.make("a"))).toEqual({
            checked: 1,
            resolved: 1,
            changed: 1,
            failed: 0,
          });
          expect(probes).toEqual(["/repos/a"]);
          expect((yield* storedIdentity("a"))?.canonicalKey).toBe("github.com/acme/renamed");
          expect(commands).toHaveLength(2);

          // Touched but identical: re-resolved quietly.
          fingerprints.set("/repos/a", "git:a|3");
          expect(yield* sync(ProjectId.make("a"))).toEqual({
            checked: 1,
            resolved: 1,
            changed: 0,
            failed: 0,
          });
          expect(commands).toHaveLength(2);
        }),
    });
  });

  it("keeps the stored identity when git cannot answer, and records it once git answers", async () => {
    const fingerprints = new Map<string, string | null>([["/repos/a", "git:a|1"]]);
    const identities = new Map([["/repos/a", identity("github.com/acme/a", "/repos/a")]]);
    const failing = new Set<string>();
    await harness({
      projects: [project("a")],
      identities,
      fingerprints,
      failing,
      body: ({ sync, probes, commands, storedIdentity, failures }) =>
        Effect.gen(function* () {
          yield* sync();
          expect(commands).toHaveLength(1);
          const projects = yield* ProjectionProjectRepository;
          const [before] = yield* projects.listRepositoryIdentityStates({
            projectId: ProjectId.make("a"),
          });

          // The config changed, and the probe times out: nothing is recorded or announced.
          fingerprints.set("/repos/a", "git:a|2");
          failing.add("/repos/a");
          expect(yield* sync()).toEqual({ checked: 1, resolved: 0, changed: 0, failed: 1 });
          expect(yield* sync()).toEqual({ checked: 1, resolved: 0, changed: 0, failed: 1 });
          const [kept] = yield* projects.listRepositoryIdentityStates({
            projectId: ProjectId.make("a"),
          });
          expect(kept).toEqual(before);
          expect((yield* storedIdentity("a"))?.canonicalKey).toBe("github.com/acme/a");
          expect(commands).toHaveLength(1);
          expect(failures).toEqual([
            ["a", 1],
            ["a", 2],
          ]);

          // git answers again: the new identity is recorded and announced.
          failing.delete("/repos/a");
          identities.set("/repos/a", identity("github.com/acme/renamed", "/repos/a"));
          probes.length = 0;
          expect(yield* sync()).toEqual({ checked: 1, resolved: 1, changed: 1, failed: 0 });
          expect(probes).toEqual(["/repos/a"]);
          expect((yield* storedIdentity("a"))?.canonicalKey).toBe("github.com/acme/renamed");
          expect(commands).toHaveLength(2);

          // Consecutive failures count again from one after an answer.
          fingerprints.set("/repos/a", "git:a|3");
          failing.add("/repos/a");
          yield* sync();
          expect(failures.at(-1)).toEqual(["a", 1]);
        }),
    });
  });

  it("never records a first resolution that failed, so the next sync probes again", async () => {
    const failing = new Set(["/repos/a"]);
    await harness({
      projects: [project("a")],
      identities: new Map([["/repos/a", identity("github.com/acme/a", "/repos/a")]]),
      fingerprints: new Map([["/repos/a", "git:a|1"]]),
      failing,
      body: ({ sync, probes, commands }) =>
        Effect.gen(function* () {
          expect(yield* sync()).toMatchObject({ failed: 1 });
          const projects = yield* ProjectionProjectRepository;
          const [state] = yield* projects.listRepositoryIdentityStates({
            projectId: ProjectId.make("a"),
          });
          expect(state).toMatchObject({ fingerprint: null, checkedAt: null });
          failing.clear();
          expect(yield* sync()).toMatchObject({ resolved: 1, changed: 1, failed: 0 });
          expect(probes).toEqual(["/repos/a", "/repos/a"]);
          expect(commands).toHaveLength(1);
        }),
    });
  });

  it("backs off retries of a failing probe up to the sweep interval", () => {
    expect(Duration.toMillis(repositoryIdentityRetryDelay(1))).toBe(60_000);
    expect(Duration.toMillis(repositoryIdentityRetryDelay(2))).toBe(120_000);
    expect(Duration.toMillis(repositoryIdentityRetryDelay(5))).toBe(16 * 60_000);
    expect(Duration.toMillis(repositoryIdentityRetryDelay(6))).toBe(30 * 60_000);
    expect(Duration.toMillis(repositoryIdentityRetryDelay(40))).toBe(30 * 60_000);
  });

  it("re-resolves a stale identity even when the fingerprint is unchanged", async () => {
    await harness({
      projects: [project("a")],
      identities: new Map([["/repos/a", identity("github.com/acme/a", "/repos/a")]]),
      fingerprints: new Map([["/repos/a", "git:a|1"]]),
      body: ({ sync, probes, setNow }) =>
        Effect.gen(function* () {
          yield* sync();
          setNow(new Date(NOW.getTime() + 25 * 60 * 60 * 1000));
          probes.length = 0;
          expect(yield* sync()).toMatchObject({ resolved: 1 });
          expect(probes).toEqual(["/repos/a"]);
        }),
    });
  });

  it("skips chat projects, missing roots and deleted projects", async () => {
    await harness({
      projects: [
        project("chat", { kind: "chat", workspaceRoot: "/chats/chat" }),
        project("missing"),
        project("deleted", { deletedAt: CREATED }),
      ],
      identities: new Map(),
      fingerprints: new Map([
        ["/chats/chat", "none"],
        ["/repos/missing", null],
        ["/repos/deleted", "none"],
      ]),
      body: ({ sync, probes }) =>
        Effect.gen(function* () {
          expect(yield* sync()).toEqual({ checked: 0, resolved: 0, changed: 0, failed: 0 });
          expect(probes).toEqual([]);
        }),
    });
  });

  it("never stores an identity for a root the project has since left", async () => {
    await harness({
      projects: [project("a")],
      identities: new Map([["/repos/a", identity("github.com/acme/a", "/repos/a")]]),
      fingerprints: new Map([["/repos/a", "git:a|1"]]),
      body: () =>
        Effect.gen(function* () {
          const projects = yield* ProjectionProjectRepository;
          const recorded = yield* projects.recordRepositoryIdentity({
            projectId: ProjectId.make("a"),
            workspaceRoot: "/repos/elsewhere",
            repositoryIdentityJson: "{}",
            fingerprint: "x",
            checkedAt: NOW.toISOString(),
          });
          expect(recorded).toBe(false);

          // A root change through the projector clears the stored identity.
          yield* projects.recordRepositoryIdentity({
            projectId: ProjectId.make("a"),
            workspaceRoot: "/repos/a",
            repositoryIdentityJson: encodePersistedRepositoryIdentity(
              identity("github.com/acme/a", "/repos/a"),
            ),
            fingerprint: "git:a|1",
            checkedAt: NOW.toISOString(),
          });
          const row = Option.getOrThrow(
            yield* projects.getById({ projectId: ProjectId.make("a") }),
          );
          yield* projects.upsert({ ...row, title: "Renamed" });
          const [kept] = yield* projects.listRepositoryIdentityStates({
            projectId: ProjectId.make("a"),
          });
          expect(kept?.fingerprint).toBe("git:a|1");
          yield* projects.upsert({ ...row, workspaceRoot: "/repos/moved" });
          const [cleared] = yield* projects.listRepositoryIdentityStates({
            projectId: ProjectId.make("a"),
          });
          expect(cleared).toMatchObject({
            workspaceRoot: "/repos/moved",
            repositoryIdentityJson: null,
            fingerprint: null,
            checkedAt: null,
          });
        }),
    });
  });

  it("keeps consuming domain events while a sync is busy, then syncs triggered projects", async () => {
    const probes: string[] = [];
    const commands: OrchestrationCommand[] = [];
    const program = Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      yield* projects.upsert(project("a"));
      // Backpressured like the engine's domain-event PubSub, with almost no headroom.
      const events = yield* PubSub.bounded<OrchestrationEvent>(2);
      const sweepStarted = yield* Deferred.make<void>();
      const releaseSweep = yield* Deferred.make<void>();
      const { drain } = yield* runRepositoryIdentitySync({
        projects,
        resolver: {
          resolve: () => Effect.die("refresh must be preferred over resolve"),
          refresh: (cwd) =>
            Effect.gen(function* () {
              probes.push(cwd);
              if (cwd === "/repos/a") {
                // The startup sweep holds the sync lock inside a slow `git`.
                yield* Deferred.succeed(sweepStarted, undefined);
                yield* Deferred.await(releaseSweep);
              }
              return identity(`github.com/acme${cwd}`, cwd);
            }),
        },
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length };
          }),
        readFingerprint: (workspaceRoot) => Effect.succeed(`git:${workspaceRoot}|1`),
        now: () => NOW,
        subscribe: PubSub.subscribe(events),
      });
      yield* Deferred.await(sweepStarted);
      yield* projects.upsert(project("b"));
      const event = (type: string, projectId: string) =>
        ({
          sequence: 1,
          eventId: `event-${type}`,
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: CREATED,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type,
          payload: { projectId },
        }) as unknown as OrchestrationEvent;
      // The trigger and then a burst of unrelated events: publishing must never wait on the sweep.
      yield* PubSub.publish(events, event("project.created", "b"));
      for (let index = 0; index < 16; index += 1) {
        yield* PubSub.publish(events, event("thread.meta-updated", "a"));
      }
      yield* Deferred.succeed(releaseSweep, undefined);
      yield* drain;
      return yield* projects.listRepositoryIdentityStates({ projectId: ProjectId.make("b") });
    }).pipe(
      Effect.scoped,
      Effect.timeout("5 seconds"),
      Effect.provide(
        ProjectionProjectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
      ),
    );
    const [b] = await Effect.runPromise(program);
    expect(probes.toSorted()).toEqual(["/repos/a", "/repos/b"]);
    expect(decodePersistedRepositoryIdentity(b?.repositoryIdentityJson ?? null)?.canonicalKey).toBe(
      "github.com/acme/repos/b",
    );
    expect(
      commands.map((command) => "projectId" in command && command.projectId).toSorted(),
    ).toEqual(["a", "b"]);
  });

  it("retries a project whose probe failed after the retry delay, not at the next sweep", async () => {
    const probes: string[] = [];
    let failing = true;
    const program = Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      yield* projects.upsert(project("a"));
      const events = yield* PubSub.bounded<OrchestrationEvent>(4);
      const firstProbe = yield* Deferred.make<void>();
      const { drain } = yield* runRepositoryIdentitySync({
        projects,
        resolver: {
          resolve: () => Effect.die("refresh must be preferred over resolve"),
          refresh: (cwd) =>
            Effect.suspend(() => {
              probes.push(cwd);
              if (!failing) return Effect.succeed(identity("github.com/acme/a", cwd));
              failing = false;
              return Deferred.succeed(firstProbe, undefined).pipe(
                Effect.andThen(
                  Effect.fail(
                    new RepositoryIdentityProbeError({
                      operation: "RepositoryIdentityResolver.showToplevel",
                      detail: "timed out",
                    }),
                  ),
                ),
              );
            }),
        },
        dispatch: () => Effect.succeed({ sequence: 1 }),
        readFingerprint: (workspaceRoot) => Effect.succeed(`git:${workspaceRoot}|1`),
        now: () => NOW,
        subscribe: PubSub.subscribe(events),
      });
      yield* Deferred.await(firstProbe);
      // Let the failed sweep finish and schedule its retry.
      for (let index = 0; index < 100; index += 1) yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.minutes(1).pipe(Duration.subtract(Duration.millis(1))));
      expect(probes).toEqual(["/repos/a"]);
      yield* TestClock.adjust(Duration.millis(1));
      for (let index = 0; index < 100 && probes.length < 2; index += 1) yield* Effect.yieldNow;
      yield* drain;
      return yield* projects.listRepositoryIdentityStates({ projectId: ProjectId.make("a") });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.merge(
          ProjectionProjectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
          TestClock.layer(),
        ),
      ),
    );
    const [a] = await Effect.runPromise(program);
    expect(probes).toEqual(["/repos/a", "/repos/a"]);
    expect(decodePersistedRepositoryIdentity(a?.repositoryIdentityJson ?? null)?.canonicalKey).toBe(
      "github.com/acme/a",
    );
  });

  it("is triggered by project creation and moves, never by its own announcement", () => {
    const base = {
      sequence: 1,
      eventId: "event",
      aggregateKind: "project",
      aggregateId: "a",
      occurredAt: CREATED,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
    };
    const event = (type: string, payload: Record<string, unknown>) =>
      ({ ...base, type, payload: { projectId: "a", ...payload } }) as unknown as OrchestrationEvent;
    expect(repositoryIdentityTrigger(event("project.created", {}))).toBe("a");
    expect(repositoryIdentityTrigger(event("project.meta-updated", { workspaceRoot: "/x" }))).toBe(
      "a",
    );
    expect(repositoryIdentityTrigger(event("project.meta-updated", { kind: "project" }))).toBe("a");
    expect(repositoryIdentityTrigger(event("project.meta-updated", { updatedAt: CREATED }))).toBe(
      null,
    );
    expect(repositoryIdentityTrigger(event("project.deleted", {}))).toBe(null);
  });
});

describe("repository identity fingerprint", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("follows the enclosing repository's config, including linked worktrees", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ryco-identity-fingerprint-"));
    directories.push(root);
    const repo = path.join(root, "repo");
    await mkdir(path.join(repo, ".git", "worktrees", "topic"), { recursive: true });
    await mkdir(path.join(repo, "packages", "web"), { recursive: true });
    await writeFile(path.join(repo, ".git", "config"), "[core]\n");
    await writeFile(path.join(repo, ".git", "worktrees", "topic", "commondir"), "../..\n");
    const linked = path.join(root, "topic");
    await mkdir(linked);
    await writeFile(
      path.join(linked, ".git"),
      `gitdir: ${path.join(repo, ".git", "worktrees", "topic")}\n`,
    );
    const plain = path.join(root, "plain");
    await mkdir(plain);

    const nested = await readRepositoryIdentityFingerprint(path.join(repo, "packages", "web"));
    const top = await readRepositoryIdentityFingerprint(repo);
    expect(nested).toBe(top);
    expect(top).toContain(path.join(repo, ".git", "config"));
    // A linked worktree reads its repository's shared config.
    const worktree = await readRepositoryIdentityFingerprint(linked);
    expect(worktree).toContain(path.join(repo, ".git", "config"));

    // Editing remotes changes the fingerprint.
    await writeFile(path.join(repo, ".git", "config"), '[remote "origin"]\n\turl = x\n');
    await utimes(path.join(repo, ".git", "config"), new Date(), new Date(Date.now() + 5_000));
    expect(await readRepositoryIdentityFingerprint(repo)).not.toBe(top);

    // A missing root is skipped (null); a plain folder has no repository ("none" or an
    // enclosing repository of the temp dir, never null).
    expect(await readRepositoryIdentityFingerprint(path.join(root, "missing"))).toBeNull();
    expect(await readRepositoryIdentityFingerprint(plain)).not.toBeNull();
  });
});
