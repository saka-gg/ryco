/**
 * nodeUpdate/preflight - `ryco node-update-preflight --database <copy>`: the check that this
 * release can start on a node, run by the release it is about to replace (cliUpdate.ts) after
 * installing it and before restarting into it.
 *
 * The process entry announces the preflight (updateProtocol.ts) and loads the CLI module, and
 * with it the server graph `ryco serve` runs; this module then loads what the server loads once
 * it serves (the terminal's PTY adapter with its native module, the Hub connector) and sets up
 * and migrates the copy of the node's database it is given exactly as the server would set up
 * the real one. It never listens, and never reads the node's configuration or state directory.
 * Its logs are dropped: stdout carries only the protocol lines and stderr the reason it failed,
 * both written synchronously, and it exits as soon as it is done, so nothing a loaded module
 * left running holds it open. A module that fails to load fails the preflight.
 *
 * @module nodeUpdate/preflight
 */
import { statSync, writeSync } from "node:fs";

import { Cause, Effect, Exit, Layer, Logger } from "effect";

import packageJson from "../../package.json" with { type: "json" };
import { makePrivateSqliteCopyLive } from "../persistence/Layers/Sqlite.ts";
import {
  NODE_UPDATE_PREFLIGHT_DATABASE_FLAG,
  NODE_UPDATE_PREFLIGHT_PASSED,
} from "./updateProtocol.ts";

const describe = (cause: unknown) =>
  cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);

const finish = (code: number, message?: string): never => {
  if (message !== undefined) writeSync(2, `${message}\n`);
  process.exit(code);
};

/** What the server loads after it serves, without running any of it. */
const loadLazyServerModules = async () => {
  if (typeof Bun !== "undefined") {
    await import("../terminal/Layers/BunPTY.ts");
  } else {
    await import("../terminal/Layers/NodePTY.ts");
    await import("node-pty");
  }
  await import("../hubConnector/HubConnectorLive.ts");
};

/** Sets up and migrates the copy at `database` as the server does its own database. */
export const migrateDatabaseCopy = (database: string) =>
  Layer.build(makePrivateSqliteCopyLive(database)).pipe(
    Effect.scoped,
    Effect.asVoid,
    Effect.provide(Logger.layer([])),
  );

export async function runNodeUpdatePreflightFromProcess(): Promise<void> {
  const version = packageJson.version;
  const flagIndex = process.argv.indexOf(NODE_UPDATE_PREFLIGHT_DATABASE_FLAG, 3);
  const database = flagIndex < 0 ? undefined : process.argv[flagIndex + 1];
  if (!database) {
    return finish(
      2,
      `Usage: ryco node-update-preflight ${NODE_UPDATE_PREFLIGHT_DATABASE_FLAG} <copy of the database>`,
    );
  }
  let isFile = false;
  try {
    isFile = statSync(database).isFile();
  } catch {
    isFile = false;
  }
  // Opening a missing file would create an empty database, and migrating that proves nothing.
  if (!isFile) return finish(1, `No database copy at ${database}.`);

  try {
    await loadLazyServerModules();
  } catch (cause) {
    return finish(1, `Ryco ${version} could not load its server: ${describe(cause)}`);
  }
  const migrated = await Effect.runPromiseExit(migrateDatabaseCopy(database));
  if (Exit.isFailure(migrated)) {
    return finish(
      1,
      `Ryco ${version} could not migrate the database copy: ${Cause.pretty(migrated.cause)}`,
    );
  }
  writeSync(1, `${NODE_UPDATE_PREFLIGHT_PASSED} ${version}\n`);
  return finish(0);
}
