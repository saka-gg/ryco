/**
 * flavorImportStartup - Ryco Nightly copies Ryco's data on the start after Ryco asked for it.
 *
 * Runs before the server graph opens the database. Boot pays one existence check, and only on a
 * desktop backend whose envelope allows a copy (`ServerConfig.flavorImport`, sent by Ryco Nightly
 * alone); the copy loads with `import()` (flavorImport/consumeFlavorImport.ts).
 *
 * @module flavorImportStartup
 */
import * as NodePath from "node:path";

import { Effect, FileSystem } from "effect";

import type { ServerConfigShape } from "./config.ts";

/**
 * Equal to `@ryco/shared/flavorImport`'s `FLAVOR_IMPORT_REQUEST_FILE_NAME`
 * (flavorImportStartup.test.ts checks): a value import would put that module, and every constant
 * the copy reads from it, in the boot chunk.
 */
export const FLAVOR_IMPORT_REQUEST_FILE = "import-requested.json";

/**
 * Copies Ryco's data into this home when the envelope allows a copy and Ryco's request is waiting
 * here. Never fails startup: a copy that cannot load or is refused leaves the data as it was.
 */
export const runRequestedFlavorImport = (
  config: Pick<ServerConfigShape, "flavorImport" | "baseDir" | "stateDir" | "dbPath">,
) =>
  Effect.gen(function* () {
    if (
      config.flavorImport !== undefined &&
      (yield* (yield* FileSystem.FileSystem).exists(
        NodePath.join(config.baseDir, FLAVOR_IMPORT_REQUEST_FILE),
      ))
    ) {
      const { runFlavorImport } = yield* Effect.tryPromise(
        () => import("./flavorImport/consumeFlavorImport.ts"),
      );
      yield* runFlavorImport(config);
    }
  }).pipe(Effect.ignore({ log: "Warn" }));
