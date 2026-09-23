/** Synthetic downgrade counterexample using the actual base repository/migrations.
 * node apps/server/scripts/reproduce-streaming-downgrade.ts
 * This deliberately demonstrates unsupported behavior, never use a real database.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { MessageId, ThreadId } from "@ryco/contracts";
import { Effect, Layer, Option } from "effect";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { ProjectionThreadMessageRepositoryLive } from "../src/persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepository } from "../src/persistence/Services/ProjectionThreadMessages.ts";

const mode = process.argv[2];
if (mode === undefined) {
  const directory = mkdtempSync(join(tmpdir(), "ryco-downgrade-"));
  try {
    const results = ["create", "old", "resume"].map((step) => {
      const stdout = execFileSync(
        process.execPath,
        [
          "--import",
          "./apps/server/scripts/streaming-sqlite-revision.ts",
          fileURLToPath(import.meta.url),
          step,
          join(directory, "fixture.sqlite"),
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            RYCO_SQLITE_FIXTURE_REF:
              step === "old" ? "1b53113f4a91f8aefc0d42db6791940fad3b4418" : "",
          },
        },
      );
      return JSON.parse(stdout.trim().split("\n").at(-1)!);
    });
    if (
      results[0].text !== "prefix more" ||
      results[1].text !== "" ||
      results[2].text !== " OLDprefix more NEW"
    )
      throw new Error("Downgrade behavior changed; reassess protection");
    console.log(JSON.stringify({ reproduced: true, results }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
} else {
  const filename = process.argv[3]!;
  const program = Effect.gen(function* () {
    const repo = yield* ProjectionThreadMessageRepository;
    const row = {
      messageId: MessageId.make("message"),
      threadId: ThreadId.make("thread"),
      turnId: null,
      role: "assistant" as const,
      text: "prefix",
      isStreaming: true,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    if (mode === "create") {
      yield* repo.applyEvent(row, 1);
      yield* repo.applyEvent({ ...row, text: " more" }, 2);
    }
    const before = Option.getOrThrow(yield* repo.getByMessageId(row));
    if (mode === "old") yield* repo.upsert({ ...before, text: before.text + " OLD" });
    if (mode === "resume") yield* repo.applyEvent({ ...row, text: " NEW" }, 3);
    console.log(
      JSON.stringify({
        mode,
        text:
          mode === "old" ? before.text : Option.getOrThrow(yield* repo.getByMessageId(row)).text,
      }),
    );
  });
  await Effect.runPromise(
    program.pipe(
      Effect.provide(
        ProjectionThreadMessageRepositoryLive.pipe(
          Layer.provide(makeSqlitePersistenceLive(filename)),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
}
