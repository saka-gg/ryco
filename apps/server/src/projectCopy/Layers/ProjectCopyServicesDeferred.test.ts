import * as fs from "node:fs";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Context, Deferred, Effect, Fiber, Layer, Option, Stream } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { PROJECT_TRANSFERS_DIRECTORY } from "../projectCopyStartup.ts";
import { GitNetwork, type GitNetworkShape } from "../Services/GitNetwork.ts";
import { NodePaths, type NodePathsShape } from "../Services/NodePaths.ts";
import { ProjectExport, type ProjectExportShape } from "../Services/ProjectExport.ts";
import { ProjectImports, type ProjectImportsShape } from "../Services/ProjectImports.ts";
import { ProjectTransfers, type ProjectTransfersShape } from "../Services/ProjectTransfers.ts";
import {
  makeProjectCopyServicesDeferred,
  type ProjectCopyServicesModule,
} from "./ProjectCopyServicesDeferred.ts";

const unused = () => Effect.die("unused");

/** Fake services, and how often their module was loaded and recovery ran. */
const makeFakeModule = (options: { readonly failFirstLoad?: boolean } = {}) => {
  const counts = { loads: 0, builds: 0, recoveries: 0 };
  /** The arguments each chunk-carrying call reached the real service with. */
  const forwarded: Array<readonly [string, ...ReadonlyArray<unknown>]> = [];
  const record =
    (method: string) =>
    (...args: ReadonlyArray<unknown>) =>
      Effect.sync(() => {
        forwarded.push([method, ...args]);
        return {} as never;
      });
  const imports: ProjectImportsShape = {
    start: unused,
    get: () => Effect.succeed(Option.none()),
    subscribe: () => Stream.empty,
    cancel: unused,
    list: () => Effect.succeed({ imports: [] }),
    discard: unused,
    recoverOnStartup: () =>
      Effect.sync(() => {
        counts.recoveries += 1;
      }),
  };
  const layer = Layer.effectContext(
    Effect.sync(() => {
      counts.builds += 1;
      return Context.make(NodePaths, {} as NodePathsShape).pipe(
        Context.add(GitNetwork, {} as GitNetworkShape),
        Context.add(ProjectExport, {
          readChunk: record("readChunk"),
        } as unknown as ProjectExportShape),
        Context.add(ProjectTransfers, {
          begin: record("begin"),
          append: record("append"),
        } as unknown as ProjectTransfersShape),
        Context.add(ProjectImports, imports),
      );
    }),
  );
  const load = async (): Promise<ProjectCopyServicesModule> => {
    counts.loads += 1;
    if (options.failFirstLoad === true && counts.loads === 1) throw new Error("chunk missing");
    return { ProjectCopyServicesLive: layer as never };
  };
  return { counts, forwarded, load };
};

const withDeferred = <A, E>(
  load: () => Promise<ProjectCopyServicesModule>,
  use: (services: {
    readonly imports: ProjectImportsShape;
    readonly exporter: ProjectExportShape;
    readonly transfers: ProjectTransfersShape;
    readonly stateDir: string;
  }) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const context = yield* makeProjectCopyServicesDeferred(load) as Effect.Effect<
      Context.Context<ProjectImports | ProjectExport | ProjectTransfers>,
      never,
      never
    >;
    const config = yield* ServerConfig;
    return yield* use({
      imports: Context.get(context, ProjectImports),
      exporter: Context.get(context, ProjectExport),
      transfers: Context.get(context, ProjectTransfers),
      stateDir: config.stateDir,
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        SqlitePersistenceMemory,
        ServerConfig.layerTest(process.cwd(), { prefix: "ryco-copy-deferred-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

describe("ProjectCopyServicesDeferred", () => {
  it.effect("loads nothing until a service is used, then builds once for every caller", () => {
    const fake = makeFakeModule();
    return withDeferred(fake.load, ({ imports }) =>
      Effect.gen(function* () {
        assert.equal(fake.counts.loads, 0);
        // A start with nothing left behind loads nothing either.
        yield* imports.recoverOnStartup();
        assert.equal(fake.counts.loads, 0);
        assert.equal(fake.counts.recoveries, 0);

        yield* Effect.all([imports.list({}), imports.list({}), imports.list({})], {
          concurrency: "unbounded",
        });
        assert.equal(fake.counts.loads, 1);
        assert.equal(fake.counts.builds, 1);
        // Once loaded, a start's recovery always runs.
        yield* imports.recoverOnStartup();
        assert.equal(fake.counts.recoveries, 1);
      }),
    );
  });

  it.effect("passes the caller's channel and chunk limit through to the real services", () => {
    const fake = makeFakeModule();
    return withDeferred(fake.load, ({ exporter, transfers }) =>
      Effect.gen(function* () {
        const read = { exportId: "export-1" } as never;
        const begin = { transferId: "transfer-1" } as never;
        const append = { transferId: "transfer-1" } as never;
        yield* exporter.readChunk(read, "unencrypted", 160 * 1024);
        yield* transfers.begin(begin, "unencrypted", 160 * 1024);
        yield* transfers.append(append, "encrypted", 160 * 1024);
        // A relayed caller's limit, not the direct default the real services fall back to.
        assert.deepEqual(fake.forwarded, [
          ["readChunk", read, "unencrypted", 160 * 1024],
          ["begin", begin, "unencrypted", 160 * 1024],
          ["append", append, "encrypted", 160 * 1024],
        ]);
      }),
    );
  });

  it.effect("loads at a start that has an import left running", () => {
    const fake = makeFakeModule();
    return withDeferred(fake.load, ({ imports }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const now = new Date().toISOString();
        yield* sql`INSERT INTO project_imports (import_id, project_id, destination_key, status,
          input_json, input_digest, snapshot_json, created_at, updated_at)
          VALUES ('import-1', 'project-1', 'key', 'running', '{}', 'digest', '{}', ${now}, ${now})`;
        yield* imports.recoverOnStartup();
        assert.equal(fake.counts.loads, 1);
        assert.equal(fake.counts.recoveries, 1);
      }),
    );
  });

  it.effect("loads at a start that has transfers on disk", () => {
    const fake = makeFakeModule();
    return withDeferred(fake.load, ({ imports, stateDir }) =>
      Effect.gen(function* () {
        const directory = path.join(stateDir, PROJECT_TRANSFERS_DIRECTORY);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, "leftover.part"), "x");
        yield* imports.recoverOnStartup();
        assert.equal(fake.counts.recoveries, 1);
      }),
    );
  });

  it.effect("fails a call whose load failed, and loads again on the next call", () => {
    const fake = makeFakeModule({ failFirstLoad: true });
    return withDeferred(fake.load, ({ imports }) =>
      Effect.gen(function* () {
        const failure = yield* imports.list({}).pipe(Effect.flip);
        assert.equal(failure.code, "internal");
        assert.include(failure.message, "could not be loaded");
        yield* imports.list({});
        assert.equal(fake.counts.loads, 2);
        assert.equal(fake.counts.builds, 1);
      }),
    );
  });

  it.effect("keeps a build going when its first caller goes away", () => {
    const fake = makeFakeModule();
    const gate = Deferred.makeUnsafe<void>();
    const slowLoad = () => Effect.runPromise(Deferred.await(gate)).then(fake.load);
    return withDeferred(slowLoad, ({ imports }) =>
      Effect.gen(function* () {
        const first = yield* imports.list({}).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(first);
        yield* Deferred.succeed(gate, undefined);
        yield* imports.list({});
        // The first caller's load went on: nothing was loaded twice.
        assert.equal(fake.counts.loads, 1);
        assert.equal(fake.counts.builds, 1);
      }),
    );
  });
});
