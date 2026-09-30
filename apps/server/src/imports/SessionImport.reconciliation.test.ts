import { afterEach, expect, it, vi } from "vitest";
import { Effect, Fiber, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { NodeServices } from "@effect/platform-node";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerSettings,
  type SessionImportSource,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
} from "@ryco/contracts";
import { makeSessionImport, type SessionImportTestOptions } from "./SessionImport.ts";
import { id, codexFixture, claudeFixture } from "./sourceHistory.fixtures.ts";
import { forkClaudeNative } from "./claudeNativeFork.ts";
import { sourceKey } from "./sourceHistory.ts";
import migration from "../persistence/Migrations/062_SessionImports.ts";
import recoveryMigration from "../persistence/Migrations/067_SessionImportRecovery.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../provider/Services/ProviderSessionDirectory.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkspaceAccessPolicy } from "../workspace/Services/WorkspaceAccessPolicy.ts";
const roots: string[] = [];
const native = "22222222-2222-4222-8222-222222222222";
const secondNative = "33333333-3333-4333-8333-333333333333";
const copyContents = (nativeId = native) =>
  codexFixture()
    .replaceAll(id, nativeId)
    .replace('"payload":{', `"payload":{"forked_from_id":"${id}",`);
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(source: SessionImportSource = "codex") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ryco-import-recovery-")));
  roots.push(root);
  const store = path.join(root, "store"),
    target = path.join(root, "target");
  await mkdir(path.join(store, "sessions"), { recursive: true });
  await mkdir(target);
  vi.stubEnv("CODEX_HOME", store);
  vi.stubEnv("CLAUDE_CONFIG_DIR", source === "claudeAgent" ? store : path.join(root, "claude"));
  const oldCwd = path.join(root, "old-project");
  const claudeDir = path.join(store, "projects", oldCwd.replace(/[^a-zA-Z0-9]/g, "-"));
  if (source === "claudeAgent") await mkdir(claudeDir, { recursive: true });
  const sourceFile =
    source === "codex"
      ? path.join(store, "sessions", `rollout-${id}.jsonl`)
      : path.join(claudeDir, `${id}.jsonl`);
  const nativeFile = path.join(store, "sessions", `rollout-${native}.jsonl`);
  const claudeIds = Object.fromEntries(
    ["user", "progress", "branch", "compact", "answer"].map((name, index) => [
      name,
      `${index + 4}`.repeat(8) + "-1111-4111-8111-111111111111",
    ]),
  );
  const claudeContents =
    claudeFixture()
      .split("\n")
      .map((line) => {
        const row = JSON.parse(line);
        return JSON.stringify({
          ...row,
          sessionId: id,
          cwd: oldCwd,
          ...(row.uuid ? { uuid: claudeIds[row.uuid] } : {}),
          ...(row.parentUuid ? { parentUuid: claudeIds[row.parentUuid] } : {}),
          ...(row.message ? { message: { role: row.type, ...row.message } } : {}),
        });
      })
      .join("\n") + "\n";
  await writeFile(sourceFile, source === "codex" ? codexFixture() : claudeContents);
  const instanceId = ProviderInstanceId.make("fixture"),
    projectId = ProjectId.make("target");
  const state = {
    beforeAdmission: undefined as (() => void) | undefined,
    published: false,
    fail: false,
    forks: 0,
    writes: 0,
    restricted: false,
    target,
    config: {
      driver: ProviderDriverKind.make(source),
      enabled: true,
      config: {},
    } as ServerSettings["providerInstances"][ProviderInstanceId],
    extra: {} as ServerSettings["providerInstances"],
    commands: new Map<string, OrchestrationCommand>(),
    bindings: [] as ProviderRuntimeBinding[],
  };
  const env = Layer.mergeAll(
    NodeSqliteClient.layer({ filename: path.join(root, "ledger.sqlite") }),
    NodeServices.layer,
    Layer.succeed(ProviderRegistry, {
      getProviders: Effect.succeed([
        {
          instanceId,
          driver: source,
          installed: true,
          enabled: true,
          models: [{ slug: "fixture-model" }],
        },
      ]),
    } as unknown as ProviderRegistry["Service"]),
    Layer.succeed(ServerSettingsService, {
      withSettingsSnapshot: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      getSettings: Effect.sync(() => ({
        providers: {},
        providerInstances: { [instanceId]: state.config, ...state.extra },
      })),
    } as unknown as ServerSettingsService["Service"]),
    Layer.succeed(ProviderSessionDirectory, {
      upsert: (binding: ProviderRuntimeBinding) =>
        Effect.sync(() => {
          state.writes++;
          state.bindings.push(binding);
        }),
    } as unknown as ProviderSessionDirectory["Service"]),
    Layer.succeed(OrchestrationEngineService, {
      dispatch: (
        command: OrchestrationCommand,
        admission?: Parameters<OrchestrationEngineService["Service"]["dispatch"]>[1],
      ) => {
        const commit = Effect.gen(function* () {
          if (state.fail) return yield* Effect.fail(new Error("synthetic interruption"));
          state.commands.set(command.commandId, command);
          state.published = true;
          return { sequence: 1 };
        });
        const admitted = Effect.sync(() => state.beforeAdmission?.()).pipe(
          Effect.andThen(admission ? admission.admit(commit) : commit),
        );
        return admission?.withCommitLease ? admission.withCommitLease(admitted) : admitted;
      },
    } as unknown as OrchestrationEngineService["Service"]),
    Layer.succeed(ProjectionSnapshotQuery, {
      getProjectShellById: () =>
        Effect.sync(() =>
          Option.some({ id: projectId, workspaceRoot: state.target } as OrchestrationProjectShell),
        ),
      getThreadShellById: () =>
        Effect.sync(() => (state.published ? Option.some({}) : Option.none())),
    } as unknown as ProjectionSnapshotQuery["Service"]),
    Layer.succeed(WorkspaceAccessPolicy, {
      get isRestricted() {
        return state.restricted;
      },
      accessRoot: undefined,
      assertExistingPath: ({ path: value }) => Effect.succeed(value),
      assertPath: ({ path: value }) => Effect.succeed(value),
    }),
  );
  const options: SessionImportTestOptions = {
    fork: async () => {
      state.forks++;
      throw new Error("uncertain fork");
    },
    verifyNative: async () => {},
  };
  const request = {
    source,
    key: sourceKey(source, store, id),
    projectId,
    modelSelection: { instanceId, model: "fixture-model" },
  };
  return { root, store, sourceFile, nativeFile, state, env, options, request };
}

it("offers only explicitly configured canonical stores, including disabled aliases, and rejects an unmatched continuation", async () => {
  const f = await fixture();
  const custom = path.join(f.root, "custom"),
    alias = path.join(f.root, "alias"),
    unrelated = path.join(f.root, "unrelated");
  await mkdir(path.join(custom, "sessions"), { recursive: true });
  await mkdir(path.join(unrelated, "sessions"), { recursive: true });
  await symlink(custom, alias);
  await writeFile(path.join(custom, "sessions", `rollout-${id}.jsonl`), codexFixture());
  await writeFile(
    path.join(unrelated, "sessions", `rollout-${id}.jsonl`),
    codexFixture().replace("fixture", "unrelated"),
  );
  f.state.extra = {
    [ProviderInstanceId.make("disabled")]: {
      driver: ProviderDriverKind.make("codex"),
      enabled: false,
      config: { homePath: custom },
    },
    [ProviderInstanceId.make("alias")]: {
      driver: ProviderDriverKind.make("codex"),
      config: {},
      environment: [{ name: "CODEX_HOME", value: alias, sensitive: false }],
    },
    [ProviderInstanceId.make("shadow")]: {
      driver: ProviderDriverKind.make("codex"),
      config: { homePath: custom, shadowHomePath: path.join(f.root, "shadow") },
    },
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* migration;
      yield* recoveryMigration;
      const importer = yield* makeSessionImport(f.options);
      const stores = yield* importer.sources({ source: "codex" });
      expect(stores).toHaveLength(2);
      const selected = stores.find((store) => !store.isDefault)!;
      expect(selected.instanceIds).toEqual(["alias", "shadow"]);
      const page = yield* importer.discover({
        source: "codex",
        storeKey: selected.key,
        search: "",
        offset: 0,
        includeArchived: true,
      });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]!.key).toBe(sourceKey("codex", custom, id));
      expect(
        (yield* Effect.exit(
          importer.importSession({ ...f.request, key: page.items[0]!.key, storeKey: selected.key }),
        ))._tag,
      ).toBe("Failure");
      expect(f.state.forks).toBe(0);
      expect(
        (yield* Effect.exit(
          importer.discover({
            source: "codex",
            storeKey: "a".repeat(64),
            search: "",
            offset: 0,
            includeArchived: false,
          }),
        ))._tag,
      ).toBe("Failure");
      f.state.restricted = true;
      expect((yield* Effect.exit(importer.sources({ source: "codex" })))._tag).toBe("Failure");
      expect((yield* Effect.exit(importer.reconcile(f.request)))._tag).toBe("Failure");
    }).pipe(Effect.provide(f.env)),
  );
});

it("distinguishes missing, multiple, mismatched and proven copies; adopts once across concurrent owners and retries", async () => {
  const f = await fixture();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* migration;
      yield* recoveryMigration;
      const importer = yield* makeSessionImport(f.options);
      expect((yield* Effect.exit(importer.importSession(f.request)))._tag).toBe("Failure");
      const missing = yield* importer.reconcile(f.request);
      expect(missing.state).toBe("missing");
      expect(missing.adoptionToken).toBeNull();
      yield* Effect.promise(() => writeFile(f.nativeFile, copyContents()));
      const another = path.join(f.store, "sessions", `rollout-${secondNative}.jsonl`);
      yield* Effect.promise(() => writeFile(another, copyContents(secondNative)));
      expect((yield* importer.reconcile(f.request)).state).toBe("multiple");
      yield* Effect.promise(() => rm(another));
      yield* Effect.promise(() =>
        writeFile(
          f.nativeFile,
          copyContents().replace("hidden analysis", "mismatched private context"),
        ),
      );
      expect((yield* importer.reconcile(f.request)).state).toBe("mismatched");
      yield* Effect.promise(() => writeFile(f.nativeFile, copyContents()));
      const original = yield* importer.reconcile(f.request);
      expect(original.state).toBe("unique");
      expect(original.adoptionToken).toBeTruthy();
      expect(JSON.stringify(original)).not.toContain("safe answer");
      const second = yield* makeSessionImport(f.options);
      const inspection = yield* second.reconcile(f.request);
      const results = yield* Effect.all(
        [
          importer.adopt({ ...f.request, adoptionToken: original.adoptionToken! }),
          second.adopt({ ...f.request, adoptionToken: inspection.adoptionToken! }),
        ],
        { concurrency: "unbounded" },
      );
      expect(results[0].threadId).toBe(results[1].threadId);
      expect(f.state.forks).toBe(1);
      expect(f.state.commands.size).toBe(1);
      expect(f.state.writes).toBe(1);
      expect(f.state.bindings[0]?.resumeCursor).toEqual({ threadId: native });
      expect(
        (yield* second.adopt({ ...f.request, adoptionToken: "lost-after-restart" }))
          .alreadyImported,
      ).toBe(true);
    }).pipe(Effect.provide(f.env)),
  );
  expect(await readFile(f.sourceFile, "utf8")).toBe(codexFixture());
});

it("rechecks settings, targets, source identity, added forks and incomplete files before adoption", async () => {
  const f = await fixture();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* migration;
      yield* recoveryMigration;
      const importer = yield* makeSessionImport(f.options);
      yield* Effect.exit(importer.importSession(f.request));
      yield* Effect.promise(() => writeFile(f.nativeFile, copyContents()));
      const inspection = yield* importer.reconcile(f.request);
      const adopt = () =>
        importer.adopt({ ...f.request, adoptionToken: inspection.adoptionToken! });
      const config = f.state.config;
      f.state.config = {
        ...config,
        environment: [{ name: "SYNTHETIC_SETTING", value: "changed", sensitive: false }],
      };
      expect((yield* Effect.exit(adopt()))._tag).toBe("Failure");
      f.state.config = config;
      f.state.target = f.root;
      expect((yield* Effect.exit(adopt()))._tag).toBe("Failure");
      f.state.target = path.join(f.root, "target");
      yield* Effect.promise(() => writeFile(f.sourceFile, codexFixture() + "\n"));
      expect((yield* Effect.exit(adopt()))._tag).toBe("Failure");
      yield* Effect.promise(() => writeFile(f.sourceFile, codexFixture()));
      // Restoring bytes still requires fresh inspection because filesystem identity changed.
      expect((yield* Effect.exit(adopt()))._tag).toBe("Failure");
      const fresh = yield* importer.reconcile(f.request);
      const another = path.join(f.store, "sessions", `rollout-${secondNative}.jsonl`);
      yield* Effect.promise(() => writeFile(another, copyContents(secondNative)));
      expect(
        (yield* Effect.exit(importer.adopt({ ...f.request, adoptionToken: fresh.adoptionToken! })))
          ._tag,
      ).toBe("Failure");
      yield* Effect.promise(() => writeFile(another, "{incomplete"));
      const unknown = yield* importer.reconcile(f.request);
      expect(unknown.state).toBe("unknown");
      expect(unknown.adoptionToken).toBeNull();
      expect(f.state.published).toBe(false);
      expect(f.state.forks).toBe(1);
    }).pipe(Effect.provide(f.env)),
  );
});

it("persists adoption before projection and re-verifies a saved copy after a real database restart", async () => {
  const f = await fixture();
  f.state.fail = true;
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* migration;
      yield* recoveryMigration;
      const importer = yield* makeSessionImport(f.options);
      yield* Effect.exit(importer.importSession(f.request));
      yield* Effect.promise(() => writeFile(f.nativeFile, copyContents()));
      const inspection = yield* importer.reconcile(f.request);
      expect(
        (yield* Effect.exit(
          importer.adopt({ ...f.request, adoptionToken: inspection.adoptionToken! }),
        ))._tag,
      ).toBe("Failure");
      const sql = yield* SqlClient.SqlClient;
      expect((yield* sql<{ phase: string }>`SELECT phase FROM session_imports`)[0]?.phase).toBe(
        "copied",
      );
    }).pipe(Effect.provide(f.env)),
  );
  f.state.fail = false;
  await writeFile(f.nativeFile, copyContents().replace("A safe answer.", "Changed copy"));
  await Effect.runPromise(
    Effect.gen(function* () {
      const importer = yield* makeSessionImport(f.options);
      expect(
        (yield* Effect.exit(importer.adopt({ ...f.request, adoptionToken: "expired" })))._tag,
      ).toBe("Failure");
      expect(f.state.published).toBe(false);
      yield* Effect.promise(() => writeFile(f.nativeFile, copyContents()));
      const result = yield* importer.adopt({ ...f.request, adoptionToken: "expired" });
      expect(result.alreadyImported).toBe(false);
      expect(f.state.forks).toBe(1);
      expect(f.state.bindings.at(-1)?.resumeCursor).toEqual({ threadId: native });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE session_imports SET completed = 0`;
      const writes = f.state.writes;
      yield* importer.adopt({ ...f.request, adoptionToken: "expired" });
      expect(f.state.writes).toBe(writes);
    }).pipe(Effect.provide(f.env)),
  );
});

it("uses a read-only real Codex protocol peer to verify provenance, target path and completed turns", async () => {
  const f = await fixture();
  const peer = path.join(f.root, "peer.cjs"),
    protocol = path.join(f.root, "protocol.json"),
    requests = path.join(f.root, "requests.jsonl");
  await writeFile(
    peer,
    `#!/usr/bin/env node
const fs = require('node:fs');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
 const request = JSON.parse(line); fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify(request) + '\\n');
 if (request.id === undefined) return;
 const result = request.method === 'initialize' ? { codexHome: process.env.CODEX_HOME, userAgent: 'synthetic', platformFamily: 'unix', platformOs: 'linux' } : JSON.parse(fs.readFileSync(${JSON.stringify(protocol)}, 'utf8'));
 process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
});\n`,
    { mode: 0o755 },
  );
  const shadow = path.join(f.root, "shadow");
  await mkdir(shadow);
  await symlink(path.join(f.store, "sessions"), path.join(shadow, "sessions"));
  f.state.config = {
    ...f.state.config,
    config: { binaryPath: peer, homePath: f.store, shadowHomePath: shadow },
  };
  const thread = {
    id: native,
    sessionId: native,
    forkedFromId: id,
    cwd: f.state.target,
    path: f.nativeFile,
    ephemeral: false,
    createdAt: 1,
    updatedAt: 1,
    cliVersion: "synthetic",
    modelProvider: "synthetic",
    preview: "",
    source: "cli",
    status: { type: "idle" },
    turns: [{ id: "completed", status: "completed", items: [] }],
  };
  await writeFile(protocol, JSON.stringify({ thread }));
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* migration;
      yield* recoveryMigration;
      const importer = yield* makeSessionImport({ fork: f.options.fork! });
      yield* Effect.exit(importer.importSession(f.request));
      yield* Effect.promise(() => writeFile(f.nativeFile, copyContents()));
      expect((yield* importer.reconcile(f.request)).state).toBe("unique");
      yield* Effect.promise(() =>
        writeFile(
          protocol,
          JSON.stringify({
            thread: { ...thread, path: path.join(shadow, "sessions", `rollout-${native}.jsonl`) },
          }),
        ),
      );
      expect((yield* importer.reconcile(f.request)).state).toBe("unique");
      yield* Effect.promise(() => writeFile(protocol, JSON.stringify({ thread: null })));
      const unknown = yield* importer.reconcile(f.request);
      expect(unknown.state).toBe("unknown");
      expect(unknown.adoptionToken).toBeNull();
      for (const mismatch of [
        { forkedFromId: secondNative },
        { cwd: f.root },
        { path: f.sourceFile },
        { turns: [{ id: "active", status: "inProgress", items: [] }] },
        { ephemeral: true },
      ]) {
        yield* Effect.promise(() =>
          writeFile(protocol, JSON.stringify({ thread: { ...thread, ...mismatch } })),
        );
        expect((yield* importer.reconcile(f.request)).state).toBe("mismatched");
      }
    }).pipe(Effect.provide(f.env)),
  );
  const methods = (await readFile(requests, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).method);
  expect(new Set(methods)).toEqual(new Set(["initialize", "initialized", "thread/read"]));
});

it("recovers a Claude copy in an explicitly configured SDK store without a model turn or source mutation", async () => {
  const f = await fixture("claudeAgent");
  // Config-dir wins over the configured HOME in both the driver and importer.
  f.state.config = {
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    config: { homePath: path.join(f.root, "instance-home") },
    environment: [{ name: "CLAUDE_CONFIG_DIR", value: f.store, sensitive: false }],
  };
  const before = await readFile(f.sourceFile, "utf8");
  let copiedId = "";
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* migration;
      yield* recoveryMigration;
      const importer = yield* makeSessionImport({
        fork: async (input) => {
          f.state.forks++;
          copiedId = await forkClaudeNative({
            root: f.store,
            sourceFile: f.sourceFile,
            sourceId: id,
            lastMessageId: input.lastMessageId,
            cwd: f.state.target,
            key: f.request.key,
          });
          throw new Error("synthetic crash after SDK fork");
        },
      });
      expect((yield* Effect.exit(importer.importSession(f.request)))._tag).toBe("Failure");
      expect(f.state.forks).toBe(1);
      expect(f.state.published).toBe(false);
      const inspection = yield* importer.reconcile(f.request);
      expect(inspection.state).toBe("unique");
      yield* importer.adopt({ ...f.request, adoptionToken: inspection.adoptionToken! });
      expect(f.state.forks).toBe(1);
      expect(f.state.bindings.at(-1)?.resumeCursor).toEqual({
        threadId: `import-${f.request.key}`,
        resume: copiedId,
        turnCount: 1,
      });
      expect(copiedId).not.toBe(id);
    }).pipe(Effect.provide(f.env)),
  );
  expect(await readFile(f.sourceFile, "utf8")).toBe(before);
});

it("retains a prepared intent when settings, target or source change before a native fork starts", async () => {
  const f = await fixture();
  f.state.config = { ...f.state.config, config: { binaryPath: "/synthetic/unavailable-provider" } };
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* migration;
      yield* recoveryMigration;
      const importer = yield* makeSessionImport();
      yield* Effect.exit(importer.importSession(f.request));
      const sql = yield* SqlClient.SqlClient;
      expect((yield* sql<{ phase: string }>`SELECT phase FROM session_imports`)[0]?.phase).toBe(
        "prepared",
      );
      const config = f.state.config;
      f.state.config = {
        ...config,
        environment: [{ name: "SYNTHETIC_SETTING", value: "changed", sensitive: false }],
      };
      expect((yield* Effect.exit(importer.importSession(f.request)))._tag).toBe("Failure");
      f.state.config = config;
      f.state.target = f.root;
      expect((yield* Effect.exit(importer.importSession(f.request)))._tag).toBe("Failure");
      f.state.target = path.join(f.root, "target");
      yield* Effect.promise(() => writeFile(f.sourceFile, codexFixture() + "\n"));
      expect((yield* Effect.exit(importer.importSession(f.request)))._tag).toBe("Failure");
      expect((yield* sql<{ phase: string }>`SELECT phase FROM session_imports`)[0]?.phase).toBe(
        "prepared",
      );
      expect(f.state.bindings).toHaveLength(0);
      expect(f.state.published).toBe(false);
    }).pipe(Effect.provide(f.env)),
  );
});

it("defers native proof to a fresh page when source and scan reads exhaust the budget", async () => {
  const f = await fixture();
  const padding = (
    JSON.stringify({ type: "synthetic_non_display", data: "x".repeat(600_000) }) + "\n"
  ).repeat(20);
  await writeFile(f.sourceFile, codexFixture() + "\n" + padding);
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* migration;
      yield* recoveryMigration;
      const importer = yield* makeSessionImport(f.options);
      yield* Effect.exit(importer.importSession(f.request));
      yield* Effect.promise(() => writeFile(f.nativeFile, copyContents() + "\n" + padding));
      const first = yield* importer.reconcile(f.request);
      expect(first.state).toBe("scanning");
      expect(first.adoptionToken).toBeNull();
      // A pagination receipt does not authorize adoption before native proof.
      expect(
        (yield* Effect.exit(importer.adopt({ ...f.request, adoptionToken: first.nextCursor! })))
          ._tag,
      ).toBe("Failure");
      const second = yield* importer.reconcile({ ...f.request, cursor: first.nextCursor! });
      expect(second.state).toBe("scanning");
      expect(second.adoptionToken).toBeNull();
      const final = yield* importer.reconcile({ ...f.request, cursor: second.nextCursor! });
      expect(final.state).toBe("unique");
      expect(final.adoptionToken).toBeTruthy();
      expect(f.state.published).toBe(false);
      expect(f.state.forks).toBe(1);
    }).pipe(Effect.provide(f.env)),
  );
});

it("pins every regular copy before interrupted publication and rechecks it after a database restart", async () => {
  const f = await fixture();
  f.state.fail = true;
  const options: SessionImportTestOptions = {
    verifyNative: f.options.verifyNative!,
    fork: async () => {
      f.state.forks++;
      await writeFile(f.nativeFile, copyContents());
      return native;
    },
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* migration;
      yield* recoveryMigration;
      const importer = yield* makeSessionImport(options);
      expect((yield* Effect.exit(importer.importSession(f.request)))._tag).toBe("Failure");
      const sql = yield* SqlClient.SqlClient;
      const saved = (yield* sql<{
        phase: string;
        native_file: string;
        native_fingerprint: string;
      }>`SELECT * FROM session_imports`)[0]!;
      expect(saved.phase).toBe("copied");
      expect(saved.native_file).toBe(f.nativeFile);
      expect(saved.native_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    }).pipe(Effect.provide(f.env)),
  );
  f.state.fail = false;
  await Effect.runPromise(
    Effect.gen(function* () {
      const importer = yield* makeSessionImport(options);
      const assertPaused = () =>
        Effect.gen(function* () {
          const writes = f.state.writes;
          expect((yield* Effect.exit(importer.importSession(f.request)))._tag).toBe("Failure");
          expect(f.state.writes).toBe(writes);
          expect(f.state.published).toBe(false);
          expect(f.state.forks).toBe(1);
        });
      yield* Effect.promise(() => rm(f.nativeFile));
      yield* assertPaused();
      yield* Effect.promise(() =>
        writeFile(f.nativeFile, copyContents().replace("A safe answer.", "Changed copy")),
      );
      yield* assertPaused();
      yield* Effect.promise(() => writeFile(f.nativeFile, copyContents()));
      yield* Effect.promise(() =>
        writeFile(f.sourceFile, codexFixture().replace("A safe answer.", "Changed original")),
      );
      yield* assertPaused();
      yield* Effect.promise(() => writeFile(f.sourceFile, codexFixture()));
      const originalConfig = f.state.config;
      f.state.config = { ...originalConfig, enabled: false };
      yield* assertPaused();
      f.state.config = originalConfig;
      vi.stubEnv("CODEX_HOME", f.root);
      yield* assertPaused();
      vi.stubEnv("CODEX_HOME", f.store);
      f.state.target = f.root;
      yield* assertPaused();
      f.state.target = path.join(f.root, "target");
      yield* importer.importSession(f.request);
      expect(f.state.bindings.at(-1)?.resumeCursor).toEqual({ threadId: native });
      const writes = f.state.writes;
      // A completed receipt is independent of later archive/settings changes.
      yield* Effect.promise(() => rm(f.nativeFile));
      f.state.config = { ...originalConfig, enabled: false };
      expect((yield* importer.importSession(f.request)).alreadyImported).toBe(true);
      expect(f.state.writes).toBe(writes);
      expect(f.state.forks).toBe(1);
    }).pipe(Effect.provide(f.env)),
  );
  expect(await readFile(f.sourceFile, "utf8")).toBe(codexFixture());
});

it.each(["settings", "store", "target", "target-alias", "source"] as const)(
  "retains a normal fork and pauses when %s changes while the native fork is pending",
  async (change) => {
    const f = await fixture();
    const originalConfig = f.state.config;
    let release!: () => void, started!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const beginning = new Promise<void>((resolve) => {
      started = resolve;
    });
    const options: SessionImportTestOptions = {
      verifyNative: f.options.verifyNative!,
      fork: async () => {
        f.state.forks++;
        await writeFile(f.nativeFile, copyContents());
        started();
        await pending;
        return native;
      },
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* migration;
        yield* recoveryMigration;
        const importer = yield* makeSessionImport(options);
        const running = yield* Effect.forkChild(Effect.exit(importer.importSession(f.request)));
        yield* Effect.promise(() => beginning);
        if (change === "settings") f.state.config = { ...originalConfig, enabled: false };
        if (change === "store") vi.stubEnv("CODEX_HOME", f.root);
        if (change === "target") f.state.target = f.root;
        if (change === "target-alias")
          yield* Effect.promise(async () => {
            await rm(f.state.target, { recursive: true });
            await symlink(f.root, f.state.target);
          });
        if (change === "source")
          yield* Effect.promise(() => writeFile(f.sourceFile, codexFixture() + "\n"));
        release();
        expect((yield* Fiber.join(running))._tag).toBe("Failure");
        expect(f.state.bindings).toHaveLength(0);
        expect(f.state.published).toBe(false);
        const sql = yield* SqlClient.SqlClient;
        const saved = (yield* sql<{
          phase: string;
          cursor_json: string;
        }>`SELECT * FROM session_imports`)[0]!;
        expect(saved.phase).toBe("copied");
        expect(JSON.parse(saved.cursor_json)).toEqual({ threadId: native });
        f.state.config = originalConfig;
        vi.stubEnv("CODEX_HOME", f.store);
        f.state.target = path.join(f.root, "target");
        if (change === "target-alias")
          yield* Effect.promise(async () => {
            await rm(f.state.target);
            await mkdir(f.state.target);
          });
        yield* Effect.promise(() => writeFile(f.sourceFile, codexFixture()));
        const restarted = yield* makeSessionImport(options);
        yield* restarted.importSession(f.request);
        expect(f.state.forks).toBe(1);
        expect(f.state.commands.size).toBe(1);
      }).pipe(Effect.provide(f.env)),
    );
  },
);

it("retains a custom-store prepared intent and its pins when retry omits the optional store key", async () => {
  const f = await fixture();
  const custom = path.join(f.root, "custom");
  await mkdir(path.join(custom, "sessions"), { recursive: true });
  const source = path.join(custom, "sessions", `rollout-${id}.jsonl`);
  await writeFile(source, codexFixture());
  f.state.config = {
    ...f.state.config,
    config: { homePath: custom, binaryPath: path.join(f.root, "missing-binary") },
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* migration;
      yield* recoveryMigration;
      const importer = yield* makeSessionImport();
      const stores = yield* importer.sources({ source: "codex" });
      const chosen = stores.find((store) => !store.isDefault)!;
      const request = { ...f.request, key: sourceKey("codex", custom, id) };
      expect(
        (yield* Effect.exit(importer.importSession({ ...request, storeKey: chosen.key })))._tag,
      ).toBe("Failure");
      const sql = yield* SqlClient.SqlClient;
      const initial = (yield* sql`SELECT * FROM session_imports`)[0]!;
      expect(initial.phase).toBe("prepared");
      expect((yield* Effect.exit(importer.importSession(request)))._tag).toBe("Failure");
      expect((yield* sql`SELECT * FROM session_imports`)[0]).toEqual(initial);
      expect(
        (yield* Effect.exit(
          importer.importSession({ ...request, projectId: ProjectId.make("different") }),
        ))._tag,
      ).toBe("Failure");
      expect(
        (yield* Effect.exit(
          importer.importSession({
            ...request,
            modelSelection: { ...request.modelSelection, model: "different" },
          }),
        ))._tag,
      ).toBe("Failure");
      yield* Effect.promise(() => writeFile(source, codexFixture() + "\n"));
      expect((yield* Effect.exit(importer.importSession(request)))._tag).toBe("Failure");
      expect((yield* sql`SELECT * FROM session_imports`)[0]).toEqual(initial);
      expect(f.state.forks).toBe(0);
      expect(f.state.bindings).toHaveLength(0);
      yield* Effect.promise(() => writeFile(source, codexFixture()));
      const resumed = yield* makeSessionImport({
        verifyNative: async () => {},
        fork: async () => {
          f.state.forks++;
          await writeFile(path.join(custom, "sessions", `rollout-${native}.jsonl`), copyContents());
          return native;
        },
      });
      yield* resumed.importSession(request);
      const completed = (yield* sql`SELECT * FROM session_imports`)[0]!;
      expect(completed.command_json).toBe(initial.command_json);
      expect(completed.source_root).toBe(custom);
      expect(completed.source_fingerprint).toBe(initial.source_fingerprint);
      expect(completed.completed).toBe(1);
      expect(f.state.forks).toBe(1);
    }).pipe(Effect.provide(f.env)),
  );
});

it("routes a successful installed Claude SDK fork through the same durable copy and publication verification", async () => {
  const f = await fixture("claudeAgent");
  const sourceBefore = await readFile(f.sourceFile, "utf8");
  f.state.fail = true;
  const options: SessionImportTestOptions = {
    fork: async (input) => {
      f.state.forks++;
      return forkClaudeNative({
        root: f.store,
        sourceFile: f.sourceFile,
        sourceId: input.sourceId,
        lastMessageId: input.lastMessageId,
        cwd: input.cwd,
        key: f.request.key,
      });
    },
  };
  let file = "",
    contents = "";
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* migration;
      yield* recoveryMigration;
      const importer = yield* makeSessionImport(options);
      expect((yield* Effect.exit(importer.importSession(f.request)))._tag).toBe("Failure");
      const sql = yield* SqlClient.SqlClient;
      const saved = (yield* sql<{
        native_file: string;
        native_fingerprint: string;
        cursor_json: string;
      }>`SELECT * FROM session_imports`)[0]!;
      expect(saved.native_fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.parse(saved.cursor_json).resume).not.toBe(id);
      file = saved.native_file;
      contents = yield* Effect.promise(() => readFile(file, "utf8"));
    }).pipe(Effect.provide(f.env)),
  );
  f.state.fail = false;
  expect(contents).toContain("Visible answer");
  await writeFile(file, contents.replace("Visible answer", "Changed SDK copy"));
  await Effect.runPromise(
    Effect.gen(function* () {
      const importer = yield* makeSessionImport(options);
      expect((yield* Effect.exit(importer.importSession(f.request)))._tag).toBe("Failure");
      expect(f.state.published).toBe(false);
      yield* Effect.promise(() => writeFile(file, contents));
      yield* importer.importSession(f.request);
      expect(f.state.forks).toBe(1);
      expect(f.state.commands.size).toBe(1);
    }).pipe(Effect.provide(f.env)),
  );
  expect(await readFile(f.sourceFile, "utf8")).toBe(sourceBefore);
});

it("rechecks current settings after native verification and a queued target change at admission", async () => {
  const f = await fixture();
  const originalConfig = f.state.config;
  let disable = true;
  const options: SessionImportTestOptions = {
    fork: async () => {
      f.state.forks++;
      await writeFile(f.nativeFile, copyContents());
      return native;
    },
    verifyNative: async () => {
      if (disable) f.state.config = { ...originalConfig, enabled: false };
    },
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* migration;
      yield* recoveryMigration;
      const importer = yield* makeSessionImport(options);
      expect((yield* Effect.exit(importer.importSession(f.request)))._tag).toBe("Failure");
      expect(f.state.bindings).toHaveLength(0);
      disable = false;
      f.state.config = originalConfig;
      f.state.beforeAdmission = () => {
        f.state.target = f.root;
      };
      expect((yield* Effect.exit(importer.importSession(f.request)))._tag).toBe("Failure");
      expect(f.state.bindings).toHaveLength(0);
      expect(f.state.published).toBe(false);
      f.state.beforeAdmission = undefined;
      f.state.target = path.join(f.root, "target");
      yield* importer.importSession(f.request);
      expect(f.state.forks).toBe(1);
      expect(f.state.commands.size).toBe(1);
    }).pipe(Effect.provide(f.env)),
  );
});
