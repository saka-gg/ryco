import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Logger } from "effect";
import { vi } from "vite-plus/test";

const runs = vi.hoisted(() => [] as Array<unknown>);
vi.mock("./flavorImport/consumeFlavorImport.ts", async () => {
  const { Effect } = await import("effect");
  return {
    runFlavorImport: (config: unknown) => {
      runs.push(config);
      return Effect.succeed({ _tag: "Stale" });
    },
  };
});

import { FLAVOR_IMPORT_REQUEST_FILE_NAME } from "@ryco/shared/flavorImport";

import { FLAVOR_IMPORT_REQUEST_FILE, runRequestedFlavorImport } from "./flavorImportStartup.ts";

describe("runRequestedFlavorImport", () => {
  it("looks for the request Ryco writes", () => {
    expect(FLAVOR_IMPORT_REQUEST_FILE).toBe(FLAVOR_IMPORT_REQUEST_FILE_NAME);
  });

  it.effect("loads the copy only when the envelope allows one and Ryco's request waits", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-flavor-import-startup-" });
      const config = {
        baseDir,
        stateDir: join(baseDir, "userdata"),
        dbPath: join(baseDir, "userdata", "state.sqlite"),
      };
      const allowed = { ...config, flavorImport: { allowedSourceHome: join(baseDir, "stable") } };

      // Every start without a request, and every start of a backend Ryco Nightly did not launch,
      // pays one check at most and loads nothing.
      yield* runRequestedFlavorImport(allowed);
      expect(runs).toEqual([]);
      yield* fs.writeFileString(join(baseDir, FLAVOR_IMPORT_REQUEST_FILE_NAME), "{}");
      yield* runRequestedFlavorImport(config);
      expect(runs).toEqual([]);

      yield* runRequestedFlavorImport(allowed);
      expect(runs).toEqual([allowed]);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, Logger.layer([])))),
  );
});
