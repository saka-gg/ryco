import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

/**
 * Counts row updates on one table through a TEMP trigger, for tests that pin which statements
 * rewrite a row and for `measure-streaming-sqlite.ts`. Temp objects live in the connection's temp
 * schema, so they never reach the main database or its WAL. It lives in `scripts/`, not
 * `src/testing/`, because the measurement script also runs over older server sources
 * (`streaming-sqlite-revision.ts` loads every `apps/server/src` module from the baseline ref).
 *
 * `columns` makes it an `UPDATE OF` probe: SQLite fires those whenever a listed column is in an
 * UPDATE's SET list, also when its value does not change, so it shows which columns a statement
 * rewrites. `when` restricts it to some rows (an SQL expression over `NEW`/`OLD`).
 */
export const installRowWriteProbe = (input: {
  readonly name: string;
  readonly table: string;
  readonly columns?: ReadonlyArray<string>;
  readonly when?: string;
}) =>
  Effect.gen(function* () {
    for (const identifier of [input.name, input.table, ...(input.columns ?? [])]) {
      if (!IDENTIFIER.test(identifier))
        return yield* Effect.die(new Error(`Not an identifier: ${identifier}`));
    }
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(
      "CREATE TEMP TABLE IF NOT EXISTS row_write_probes (name TEXT PRIMARY KEY, writes INTEGER NOT NULL)",
    );
    yield* sql`INSERT INTO row_write_probes (name, writes) VALUES (${input.name}, 0)`;
    const columns = input.columns === undefined ? "" : ` OF ${input.columns.join(", ")}`;
    const when = input.when === undefined ? "" : ` WHEN ${input.when}`;
    yield* sql.unsafe(
      `CREATE TEMP TRIGGER row_write_probe_${input.name} AFTER UPDATE${columns} ON main.${input.table}${when}
       BEGIN UPDATE row_write_probes SET writes = writes + 1 WHERE name = '${input.name}'; END`,
    );
    return sql<{ readonly writes: number }>`
      SELECT writes FROM row_write_probes WHERE name = ${input.name}
    `.pipe(Effect.map((rows) => rows[0]?.writes ?? 0));
  });
