import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@ryco/contracts";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { CursorDriver } from "./CursorDriver.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "cursor-driver-test" }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
      ),
    ),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(ServerSettingsService.layerTest()),
);

/** A PATH directory holding executables with these names. */
const makeBinDir = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(path.join(os.tmpdir(), "ryco-cursor-driver-"))),
  (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
);

const writeExecutables = (directory: string, names: ReadonlyArray<string>) => {
  mkdirSync(directory, { recursive: true });
  for (const name of names) {
    const file = path.join(directory, name);
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o755);
  }
};

describe("CursorDriver", () => {
  it.effect("updates through the resolved Cursor command, never another CLI's agent", () =>
    Effect.gen(function* () {
      // Another CLI's `agent` comes first on PATH; Cursor's own commands come later.
      const foreignDir = yield* makeBinDir;
      const cursorDir = yield* makeBinDir;
      writeExecutables(foreignDir, ["agent"]);
      writeExecutables(cursorDir, ["agent", "cursor-agent"]);
      const instance = yield* CursorDriver.create({
        instanceId: ProviderInstanceId.make("cursor"),
        displayName: undefined,
        environment: [
          { name: "PATH", value: [foreignDir, cursorDir].join(path.delimiter), sensitive: false },
        ],
        enabled: true,
        config: CursorDriver.defaultConfig(),
      });

      const capabilities = yield* instance.snapshot.maintenanceCapabilities;
      expect(capabilities.update).toMatchObject({
        executable: path.join(cursorDir, "cursor-agent"),
        args: ["update"],
        lockKey: "cursor-agent",
      });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
