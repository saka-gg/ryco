import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { afterEach, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeServices } from "@effect/platform-node";
import { ProviderDriverKind } from "@ryco/contracts";
import { makeSessionImport } from "./SessionImport.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import recoveryMigration from "../persistence/Migrations/067_SessionImportRecovery.ts";
import migration from "../persistence/Migrations/062_SessionImports.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkspaceAccessPolicy } from "../workspace/Services/WorkspaceAccessPolicy.ts";
import { id, codexFixture } from "./sourceHistory.fixtures.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const environment = (restricted: boolean) =>
  Layer.mergeAll(
    NodeSqliteClient.layerMemory(),
    NodeServices.layer,
    Layer.succeed(ProviderRegistry, {
      getProviders: Effect.succeed([]),
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
    Layer.succeed(ProviderSessionDirectory, {} as unknown as ProviderSessionDirectory["Service"]),
    Layer.succeed(
      OrchestrationEngineService,
      {} as unknown as OrchestrationEngineService["Service"],
    ),
    Layer.succeed(ProjectionSnapshotQuery, {
      getProjectShellById: () => Effect.succeed(Option.none()),
    } as unknown as ProjectionSnapshotQuery["Service"]),
    Layer.succeed(WorkspaceAccessPolicy, {
      isRestricted: restricted,
      accessRoot: restricted ? "/restricted" : undefined,
      assertExistingPath: ({ path: value }) => Effect.succeed(value),
      assertPath: ({ path: value }) => Effect.succeed(value),
    }),
  );

const conversation = (sessionId: string, cwd: string) =>
  codexFixture()
    .replaceAll(id, sessionId)
    .replace(JSON.stringify("C:\\old\\project"), JSON.stringify(cwd));

it("reports each conversation's folder as the node resolves it, so project import can group by it", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ryco-import-folders-")));
  roots.push(root);
  const project = path.join(root, "work", "project");
  const alias = path.join(root, "alias");
  const plainFile = path.join(root, "not-a-folder");
  await mkdir(project, { recursive: true });
  await symlink(project, alias);
  await writeFile(plainFile, "");
  await mkdir(path.join(root, "store", "sessions"), { recursive: true });
  const cases = {
    "11111111-1111-4111-8111-111111111111": project,
    "22222222-2222-4222-8222-222222222222": `${alias}${path.sep}`,
    "33333333-3333-4333-8333-333333333333": path.join(root, "deleted-worktree"),
    "44444444-4444-4444-8444-444444444444": plainFile,
  };
  for (const [sessionId, cwd] of Object.entries(cases))
    await writeFile(
      path.join(root, "store", "sessions", `rollout-${sessionId}.jsonl`),
      conversation(sessionId, cwd),
    );
  const options = { rootForSource: () => path.join(root, "store") };
  const discover = { source: "codex", search: "", offset: 0, includeArchived: false } as const;

  const page = await Effect.runPromise(
    Effect.gen(function* () {
      yield* migration;
      yield* recoveryMigration;
      return yield* (yield* makeSessionImport(options)).discover(discover);
    }).pipe(Effect.provide(environment(false))),
  );

  const byFolder = Object.fromEntries(page.items.map((item) => [item.cwd, item.canonicalCwd]));
  expect(byFolder).toEqual({
    [project]: project,
    // A linked spelling of the same folder resolves to the same real path.
    [`${alias}${path.sep}`]: project,
    // Gone or not a directory: no folder a project could be created in.
    [path.join(root, "deleted-worktree")]: null,
    [plainFile]: null,
  });

  // A workspace-restricted node still refuses discovery outright.
  const restricted = await Effect.runPromise(
    Effect.gen(function* () {
      yield* migration;
      yield* recoveryMigration;
      return yield* Effect.exit((yield* makeSessionImport(options)).discover(discover));
    }).pipe(Effect.provide(environment(true))),
  );
  expect(restricted._tag).toBe("Failure");
});
