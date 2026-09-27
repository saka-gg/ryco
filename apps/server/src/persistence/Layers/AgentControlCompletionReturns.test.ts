import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect, Layer } from "effect";
import { expect, it } from "vite-plus/test";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { runMigrations } from "../Migrations.ts";
import {
  CompletionReturnRepository,
  CompletionReturnRepositoryLive,
} from "./AgentControlCompletionReturns.ts";
import { completionFixture } from "../../agentControl/completionReturnTestSupport.ts";

it("preserves return ownership and recovery state across closing and reopening the database", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-return-restart-fixture-"));
  try {
    const connect = () =>
      CompletionReturnRepositoryLive.pipe(
        Layer.provideMerge(
          Layer.effectDiscard(runMigrations()).pipe(
            Layer.provideMerge(
              NodeSqliteClient.layer({ filename: path.join(directory, "fixture.sqlite") }),
            ),
          ),
        ),
      );
    const initial = completionFixture();
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CompletionReturnRepository;
        yield* repo.insert(initial);
        expect(
          yield* repo.save(initial, {
            ...initial,
            status: "dispatching",
            detail: "Dispatch claimed; inspect receipt on recovery.",
          }),
        ).toBe(true);
      }).pipe(Effect.provide(connect())),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* CompletionReturnRepository;
        const restored = yield* repo.get(initial.childThreadId);
        expect(restored).toMatchObject({
          status: "dispatching",
          revision: 1,
          parentTurnId: initial.parentTurnId,
          parentRuntimeSessionId: initial.parentRuntimeSessionId,
          initialMessageId: initial.initialMessageId,
        });
        expect((yield* repo.listDue(initial.nextCheckAt)).length).toBe(1);
        expect(yield* repo.save(initial, { ...initial, status: "delivered" })).toBe(false);
      }).pipe(Effect.provide(connect())),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
