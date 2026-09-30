import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeServices } from "@effect/platform-node";
import {
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
} from "@ryco/contracts";
import { makeSessionImport } from "./SessionImport.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import recoveryMigration from "../persistence/Migrations/067_SessionImportRecovery.ts";
import migration from "../persistence/Migrations/062_SessionImports.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../provider/Services/ProviderSessionDirectory.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkspaceAccessPolicy } from "../workspace/Services/WorkspaceAccessPolicy.ts";
import { sourceKey } from "./sourceHistory.ts";
import { id, codexFixture } from "./sourceHistory.fixtures.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("restarts an interrupted import without reforking, deduplicates completed retries and never resumes the source", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ryco-import-restart-")));
  roots.push(root);
  await mkdir(path.join(root, "sessions"));
  const file = path.join(root, "sessions", `rollout-${id}.jsonl`);
  await writeFile(file, codexFixture());
  const native = "22222222-2222-4222-8222-222222222222";
  const projectId = ProjectId.make("target");
  const instanceId = ProviderInstanceId.make("codex");
  let published = false;
  let forks = 0,
    fail = true,
    writes = 0;
  const commands = new Map<string, OrchestrationCommand>();
  const bindings: ProviderRuntimeBinding[] = [];
  const env = Layer.mergeAll(
    NodeSqliteClient.layerMemory(),
    NodeServices.layer,
    Layer.succeed(ProviderRegistry, {
      getProviders: Effect.succeed([
        {
          instanceId,
          driver: "codex",
          installed: true,
          enabled: true,
          models: [{ slug: "fixture-model" }],
        },
      ]),
    } as unknown as ProviderRegistry["Service"]),
    Layer.succeed(ServerSettingsService, {
      withSettingsSnapshot: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      getSettings: Effect.succeed({
        providers: {},
        providerInstances: {
          codex: { driver: ProviderDriverKind.make("codex"), enabled: true, config: {} },
        },
      }),
    } as unknown as ServerSettingsService["Service"]),
    Layer.succeed(ProviderSessionDirectory, {
      upsert: (binding: ProviderRuntimeBinding) =>
        Effect.sync(() => {
          writes++;
          bindings.push(binding);
        }),
    } as unknown as ProviderSessionDirectory["Service"]),
    Layer.succeed(OrchestrationEngineService, {
      dispatch: (
        command: OrchestrationCommand,
        admission?: Parameters<OrchestrationEngineService["Service"]["dispatch"]>[1],
      ) => {
        const commit = Effect.gen(function* () {
          if (fail) return yield* Effect.fail(new Error("synthetic process interruption"));
          commands.set(command.commandId, command);
          published = true;
          return { sequence: 1 };
        });
        const admitted = admission ? admission.admit(commit) : commit;
        return admission?.withCommitLease ? admission.withCommitLease(admitted) : admitted;
      },
    } as unknown as OrchestrationEngineService["Service"]),
    Layer.succeed(ProjectionSnapshotQuery, {
      getProjectShellById: () =>
        Effect.succeed(
          Option.some({ id: projectId, workspaceRoot: root } as OrchestrationProjectShell),
        ),
      getThreadShellById: () => Effect.succeed(published ? Option.some({}) : Option.none()),
    } as unknown as ProjectionSnapshotQuery["Service"]),
    Layer.succeed(WorkspaceAccessPolicy, {
      isRestricted: false,
      accessRoot: undefined,
      assertExistingPath: ({ path: value }) => Effect.succeed(value),
      assertPath: ({ path: value }) => Effect.succeed(value),
    }),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* migration;
      yield* recoveryMigration;
      const options = {
        rootForSource: () => root,
        fork: async ({ sourceId }: { sourceId: string }) => {
          forks++;
          const copiedId = sourceId === id ? native : "88888888-1111-4111-8111-111111111111";
          const contents = await readFile(
            path.join(root, "sessions", `rollout-${sourceId}.jsonl`),
            "utf8",
          );
          await writeFile(
            path.join(root, "sessions", `rollout-${copiedId}.jsonl`),
            contents
              .replaceAll(sourceId, copiedId)
              .replace('"payload":{', `"payload":{"forked_from_id":"${sourceId}",`),
          );
          return copiedId;
        },
        verifyNative: async () => {},
      };
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* makeSessionImport(options);
      const page = yield* importer.discover({
        source: "codex",
        search: "fixture",
        offset: 0,
        includeArchived: false,
      });
      expect(page.items).toHaveLength(1);
      const request = {
        source: "codex" as const,
        key: page.items[0]!.key,
        projectId,
        modelSelection: { instanceId, model: "fixture-model" },
      };
      expect(
        (yield* Effect.exit(
          importer.importSession({
            ...request,
            modelSelection: { ...request.modelSelection, model: "unavailable-model" },
          }),
        ))._tag,
      ).toBe("Failure");
      expect(forks).toBe(0);
      expect((yield* Effect.exit(importer.importSession(request)))._tag).toBe("Failure");
      expect(forks).toBe(1);
      expect(
        (yield* Effect.exit(
          importer.importSession({ ...request, projectId: ProjectId.make("changed") }),
        ))._tag,
      ).toBe("Failure");
      expect(
        (yield* Effect.exit(
          importer.importSession({
            ...request,
            modelSelection: { instanceId: ProviderInstanceId.make("changed"), model: "fixture" },
          }),
        ))._tag,
      ).toBe("Failure");
      expect(forks).toBe(1);
      fail = false;
      // Reconstruct all process-local importer state while retaining its database.
      const restarted = yield* makeSessionImport(options);
      const result = yield* restarted.importSession(request);
      expect(result.alreadyImported).toBe(false);
      expect(forks).toBe(1);
      expect(commands.size).toBe(1);
      const binding = bindings.at(-1)!;
      expect(binding.resumeCursor).toEqual({ threadId: native });
      expect(binding.runtimeSessionId).not.toBe(id);
      const before = writes;
      expect((yield* restarted.importSession(request)).alreadyImported).toBe(true);
      expect(writes).toBe(before);
      const command = [...commands.values()][0]!;
      expect(command.type).toBe("thread.history.import");
      if (command.type === "thread.history.import") {
        expect(
          command.messages.every((message) => !message.streaming && message.turnId !== null),
        ).toBe(true);
        expect(command.messages.map((message) => message.text)).toEqual([
          "Please explain this fixture.",
          "A safe answer.",
        ]);
      }
      expect(
        (yield* restarted.discover({
          source: "codex",
          search: "",
          offset: 0,
          includeArchived: false,
        })).items[0]?.importedThreadId,
      ).toBe(result.threadId);
      // Crash after publication but before completion acknowledgement must never
      // replace a runtime cursor that may already contain new turns.
      yield* sql`UPDATE session_imports SET completed = 0 WHERE source_key = ${request.key}`;
      yield* restarted.importSession(request);
      expect(writes).toBe(before);
      expect(forks).toBe(1);
      // Recheck a retained copy after a crash between identity persistence and
      // source verification. A changed source stays paused; a stable one recovers.
      yield* sql`UPDATE session_imports SET completed = 0, phase = 'source-changed' WHERE source_key = ${request.key}`;
      yield* Effect.promise(() => writeFile(file, codexFixture() + "\n"));
      expect((yield* Effect.exit(restarted.importSession(request)))._tag).toBe("Failure");
      yield* Effect.promise(() => writeFile(file, codexFixture()));
      yield* restarted.importSession(request);
      expect(forks).toBe(1);
      // Crash during a native fork has no transactional acknowledgement. Refuse
      // another external fork and do not present an untracked copy as a source.
      yield* sql`UPDATE session_imports SET completed = 0, phase = 'forking' WHERE source_key = ${request.key}`;
      const uncertain = yield* makeSessionImport(options);
      expect((yield* Effect.exit(uncertain.importSession(request)))._tag).toBe("Failure");
      const unrelatedId = "66666666-1111-4111-8111-111111111111";
      const orphanId = "77777777-1111-4111-8111-111111111111";
      const unrelatedFile = path.join(root, "sessions", `rollout-${unrelatedId}.jsonl`);
      const orphanFile = path.join(root, "sessions", `rollout-${orphanId}.jsonl`);
      yield* Effect.promise(() =>
        writeFile(unrelatedFile, codexFixture().replaceAll(id, unrelatedId)),
      );
      yield* Effect.promise(() =>
        writeFile(
          orphanFile,
          codexFixture()
            .replaceAll(id, orphanId)
            .replace('"payload":{', `"payload":{"forked_from_id":"${id}",`),
        ),
      );
      const available = yield* uncertain.discover({
        source: "codex",
        search: "",
        offset: 0,
        includeArchived: true,
      });
      expect(available.items).toHaveLength(2);
      expect(available.items.find((item) => item.key === request.key)?.quarantined).toBe(true);
      const unrelated = available.items.find((item) => item.key !== request.key)!;
      expect(unrelated.quarantined).toBe(false);
      expect(
        (yield* Effect.exit(
          uncertain.importSession({ ...request, key: sourceKey("codex", root, orphanId) }),
        ))._tag,
      ).toBe("Failure");
      expect(forks).toBe(1);
      yield* uncertain.importSession({ ...request, key: unrelated.key });
      expect(forks).toBe(2);
      yield* Effect.promise(() => Promise.all([rm(unrelatedFile), rm(orphanFile)]));
      // Prepared intent means no native operation started, so retry is safe.
      yield* sql`UPDATE session_imports SET phase = 'prepared' WHERE source_key = ${request.key}`;
      yield* uncertain.importSession(request);
      expect(forks).toBe(3);
      // Aggregate budgets apply to uncached bytes, even when each file is legal.
      const padding = (
        JSON.stringify({ type: "fixture_non_display", data: "x".repeat(600_000) }) + "\n"
      ).repeat(20);
      for (let index = 3; index <= 5; index++) {
        const sourceId = `${index}`.repeat(8) + "-1111-4111-8111-111111111111";
        yield* Effect.promise(() =>
          writeFile(
            path.join(root, "sessions", `rollout-${sourceId}.jsonl`),
            codexFixture().replaceAll(id, sourceId) + "\n" + padding,
          ),
        );
      }
      const bounded = yield* makeSessionImport(options);
      const first = yield* bounded.discover({
        source: "codex",
        search: "",
        offset: 0,
        includeArchived: false,
      });
      expect(first.nextOffset).not.toBeNull();
      const second = yield* bounded.discover({
        source: "codex",
        search: "",
        offset: first.nextOffset!,
        includeArchived: false,
      });
      expect(first.items.length + second.items.length).toBe(4);
      const cached = yield* bounded.discover({
        source: "codex",
        search: "",
        offset: 0,
        includeArchived: false,
      });
      expect(cached.items).toHaveLength(4);
    }).pipe(Effect.provide(env)),
  );
  expect(await readFile(file, "utf8")).toBe(codexFixture());
});
