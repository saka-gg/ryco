/**
 * Port of `@effect/sql-sqlite-node` that uses the native `node:sqlite`
 * bindings instead of `better-sqlite3`.
 *
 * @module SqliteClient
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";

import * as Cache from "effect/Cache";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Client from "effect/sql/SqlClient";
import type { Connection } from "effect/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";

import { BUSY_RETRY_BUDGET_MS, busyRetryDelayMs, isRetryableSqliteBusy } from "./sqliteBusy.ts";

const ATTR_DB_SYSTEM_NAME = "db.system.name";

export const TypeId: TypeId = "~local/sqlite-node/SqliteClient";

export type TypeId = "~local/sqlite-node/SqliteClient";

/**
 * SqliteClient - Effect service tag for the sqlite SQL client.
 */
export const SqliteClient = Context.Service<Client.SqlClient>("ryco/persistence/NodeSqliteClient");

export interface SqliteClientConfig {
  readonly filename: string;
  readonly readonly?: boolean | undefined;
  readonly allowExtension?: boolean | undefined;
  readonly prepareCacheSize?: number | undefined;
  readonly prepareCacheTTL?: Duration.Input | undefined;
  readonly spanAttributes?: Record<string, unknown> | undefined;
  readonly transformResultNames?: ((str: string) => string) | undefined;
  readonly transformQueryNames?: ((str: string) => string) | undefined;
  /** How long a busy statement keeps retrying asynchronously. Defaults to {@link BUSY_RETRY_BUDGET_MS}. */
  readonly busyRetryBudgetMs?: number | undefined;
}

export interface SqliteMemoryClientConfig extends Omit<
  SqliteClientConfig,
  "filename" | "readonly"
> {}

/**
 * Verify that the current Node.js version includes the `node:sqlite` APIs
 * used by `NodeSqliteClient` — specifically `StatementSync.columns()` (added
 * in Node 22.16.0 / 23.11.0).
 *
 * @see https://github.com/nodejs/node/pull/57490
 */
const checkNodeSqliteCompat = () => {
  const parts = process.versions.node.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const supported = (major === 22 && minor >= 16) || (major === 23 && minor >= 11) || major >= 24;

  if (!supported) {
    return Effect.die(
      `Node.js ${process.versions.node} is missing required node:sqlite APIs ` +
        `(StatementSync.columns). Upgrade to Node.js >=22.16, >=23.11, or >=24.`,
    );
  }
  return Effect.void;
};

/**
 * Waits on the real timer, not the fiber's Clock: another process's lock is
 * released in wall-clock time, also under a test clock that never advances.
 */
const wallClockSleep = (ms: number): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const timer = setTimeout(() => resume(Effect.void), ms);
    return Effect.sync(() => clearTimeout(timer));
  });

const makeWithDatabase = Effect.fn("makeWithDatabase")(function* (
  options: SqliteClientConfig,
  openDatabase: () => DatabaseSync,
): Effect.fn.Return<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> {
  yield* checkNodeSqliteCompat();

  const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
  const transformRows = options.transformResultNames
    ? Statement.defaultTransforms(options.transformResultNames).array
    : undefined;

  const busyRetryBudgetMs = options.busyRetryBudgetMs ?? BUSY_RETRY_BUDGET_MS;

  const makeConnection = Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const db = openDatabase();
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => db.close()),
    );

    const statementReaderCache = new WeakMap<StatementSync, boolean>();
    const hasRows = (statement: StatementSync): boolean => {
      const cached = statementReaderCache.get(statement);
      if (cached !== undefined) {
        return cached;
      }
      const value = statement.columns().length > 0;
      statementReaderCache.set(statement, value);
      return value;
    };

    const prepareCache = yield* Cache.make({
      capacity: options.prepareCacheSize ?? 200,
      timeToLive: options.prepareCacheTTL ?? Duration.minutes(10),
      lookup: (sql: string) =>
        Effect.try({
          try: () => db.prepare(sql),
          catch: (cause) =>
            new SqlError({
              reason: classifySqliteError(cause, {
                message: "Failed to prepare statement",
                operation: "prepare",
              }),
            }),
        }),
    });

    /**
     * Runs one synchronous statement. A busy database is retried
     * asynchronously (see sqliteBusy.ts) so the event loop keeps running while
     * another process holds the write lock; a failed busy attempt changes no
     * state, so re-running the statement is safe, also inside a transaction.
     */
    const execute = <A>(attempt: () => A, message: string): Effect.Effect<A, SqlError> => {
      let startedAt: number | undefined;
      let retries = 0;
      const loop: Effect.Effect<A, SqlError> = Effect.suspend(() => {
        try {
          return Effect.succeed(attempt());
        } catch (cause) {
          startedAt ??= Date.now();
          if (isRetryableSqliteBusy(cause) && Date.now() - startedAt < busyRetryBudgetMs) {
            return Effect.flatMap(wallClockSleep(busyRetryDelayMs(retries++)), () => loop);
          }
          return Effect.fail(
            new SqlError({
              reason: classifySqliteError(cause, { message, operation: "execute" }),
            }),
          );
        }
      });
      return loop;
    };

    const runStatement = (statement: StatementSync, params: ReadonlyArray<unknown>, raw: boolean) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
        statement.setReadBigInts(Boolean(Context.get(fiber.context, Client.SafeIntegers)));
        return execute(() => {
          if (hasRows(statement)) {
            return statement.all(...(params as any));
          }
          const result = statement.run(...(params as any));
          return raw ? (result as unknown as ReadonlyArray<any>) : [];
        }, "Failed to execute statement");
      });

    const run = (sql: string, params: ReadonlyArray<unknown>, raw = false) =>
      Effect.flatMap(Cache.get(prepareCache, sql), (s) => runStatement(s, params, raw));

    const allValues = (statement: StatementSync, params: ReadonlyArray<unknown>) => {
      if (!hasRows(statement)) {
        statement.run(...(params as any));
        return [];
      }
      statement.setReturnArrays(true);
      try {
        // Safe to cast to array after we've setReturnArrays(true)
        return statement.all(...(params as any)) as unknown as ReadonlyArray<
          ReadonlyArray<unknown>
        >;
      } finally {
        statement.setReturnArrays(false);
      }
    };

    const runValues = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.flatMap(Cache.get(prepareCache, sql), (statement) =>
        execute(() => allValues(statement, params), "Failed to execute statement"),
      );

    return identity<Connection>({
      execute(sql, params, rowTransform) {
        return rowTransform ? Effect.map(run(sql, params), rowTransform) : run(sql, params);
      },
      executeRaw(sql, params) {
        return run(sql, params, true);
      },
      executeValues(sql, params) {
        return runValues(sql, params);
      },
      executeValuesUnprepared(sql, params) {
        return execute(
          () => allValues(db.prepare(sql), params),
          "Failed to execute unprepared values statement",
        );
      },
      executeUnprepared(sql, params, rowTransform) {
        const effect = runStatement(db.prepare(sql), params ?? [], false);
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_sql, _params) {
        return Stream.die("executeStream not implemented");
      },
    });
  });

  const semaphore = yield* Semaphore.make(1);
  const connection = yield* makeConnection;

  const acquirer = semaphore.withPermits(1)(Effect.succeed(connection));
  const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
    const fiber = Fiber.getCurrent()!;
    const scope = Context.getUnsafe(fiber.context, Scope.Scope);
    return Effect.as(
      Effect.tap(restore(semaphore.take(1)), () => Scope.addFinalizer(scope, semaphore.release(1))),
      connection,
    );
  });

  return yield* Client.make({
    acquirer,
    compiler,
    transactionAcquirer,
    spanAttributes: [
      ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
      [ATTR_DB_SYSTEM_NAME, "sqlite"],
    ],
    transformRows,
  });
});

const make = (
  options: SqliteClientConfig,
): Effect.Effect<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> =>
  makeWithDatabase(
    options,
    () =>
      new DatabaseSync(options.filename, {
        readOnly: options.readonly ?? false,
        allowExtension: options.allowExtension ?? false,
      }),
  );

const makeMemory = (
  config: SqliteMemoryClientConfig = {},
): Effect.Effect<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> =>
  makeWithDatabase(
    {
      ...config,
      filename: ":memory:",
      readonly: false,
    },
    () => {
      const database = new DatabaseSync(":memory:", {
        allowExtension: config.allowExtension ?? false,
      });
      return database;
    },
  );

export const layerConfig = (
  config: Config.Wrap<SqliteClientConfig>,
): Layer.Layer<Client.SqlClient, Config.ConfigError> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const resolved = yield* Config.unwrap(config);
      const client = yield* make(resolved);
      return Context.make(SqliteClient, client).pipe(Context.add(Client.SqlClient, client));
    }),
  ).pipe(Layer.provide(Reactivity.layer));

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient> =>
  Layer.effectContext(
    Effect.map(make(config), (client) =>
      Context.make(SqliteClient, client).pipe(Context.add(Client.SqlClient, client)),
    ),
  ).pipe(Layer.provide(Reactivity.layer));

export const layerMemory = (config: SqliteMemoryClientConfig = {}): Layer.Layer<Client.SqlClient> =>
  Layer.effectContext(
    Effect.map(makeMemory(config), (client) =>
      Context.make(SqliteClient, client).pipe(Context.add(Client.SqlClient, client)),
    ),
  ).pipe(Layer.provide(Reactivity.layer));
