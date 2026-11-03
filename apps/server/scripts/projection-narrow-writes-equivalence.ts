/** Differential check of the projection pipeline between two server source trees.
 *
 * Applies seeded random event streams (projectionEventStream.ts) through the production event
 * store and projection pipeline, one transaction per event, on a fresh in-memory database per
 * seed, and prints one hash of the narrowed projections per event.
 *
 *   # One tree (the working tree, or a commit through the read-only source overlay):
 *   node apps/server/scripts/projection-narrow-writes-equivalence.ts [seeds=30] [events=150]
 *   RYCO_SQLITE_FIXTURE_REF=<ref> node --import ./apps/server/scripts/streaming-sqlite-revision.ts \
 *     apps/server/scripts/projection-narrow-writes-equivalence.ts [seeds] [events]
 *   # Both, compared line by line (prints a summary; exits 1 on any mismatch):
 *   node apps/server/scripts/projection-narrow-writes-equivalence.ts --against <ref> [seeds] [events]
 *
 * Any `apps/server/src` module imported here must exist at the baseline ref.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../src/config.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionPipeline } from "../src/orchestration/Services/ProjectionPipeline.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../src/persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../src/persistence/Services/OrchestrationEventStore.ts";
import { ProjectAvatarStore } from "../src/project/Services/ProjectAvatarStore.ts";
import {
  applyProjectionStreamEvent,
  dumpNarrowWriteProjections,
  hashDump,
  makeProjectionEventStream,
  maxPendingCounts,
} from "./projectionEventStream.ts";

const args = process.argv.slice(2);
const againstIndex = args.indexOf("--against");
const against = againstIndex === -1 ? undefined : args[againstIndex + 1];
// A forgotten ref must not turn the comparison into a one-tree run that exits 0.
if (againstIndex !== -1 && (against === undefined || against === "" || against.startsWith("-")))
  throw new Error("--against needs a git ref");
const positional = againstIndex === -1 ? args : args.toSpliced(againstIndex, 2);
const seeds = Number(positional[0] ?? 30);
const eventsPerSeed = Number(positional[1] ?? 150);
if (
  !Number.isSafeInteger(seeds) ||
  seeds < 1 ||
  !Number.isSafeInteger(eventsPerSeed) ||
  eventsPerSeed < 0
)
  throw new Error("Use a positive seed count and a non-negative event count");

if (against !== undefined) {
  const script = fileURLToPath(import.meta.url);
  const revision = fileURLToPath(new URL("./streaming-sqlite-revision.ts", import.meta.url));
  const run = (baseline: boolean) =>
    execFileSync(
      process.execPath,
      [...(baseline ? ["--import", revision] : []), script, String(seeds), String(eventsPerSeed)],
      {
        env: { ...process.env, RYCO_SQLITE_FIXTURE_REF: baseline ? against : "" },
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "inherit"],
      },
    )
      .trim()
      .split("\n")
      .filter((line) => line.startsWith("step "));
  const baselineLines = run(true);
  const currentLines = run(false);
  const mismatches = currentLines.flatMap((line, index) =>
    line === baselineLines[index] ? [] : [{ baseline: baselineLines[index], current: line }],
  );
  const summary = {
    against,
    seeds,
    eventsPerSeed,
    steps: currentLines.length,
    identical: currentLines.length - mismatches.length,
    lengthsMatch: currentLines.length === baselineLines.length,
    firstMismatches: mismatches.slice(0, 5),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (mismatches.length > 0 || !summary.lengthsMatch) process.exitCode = 1;
} else {
  const layer = OrchestrationProjectionPipelineLive.pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "ryco-narrow-writes-equivalence-" }),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectAvatarStore, {
        write: () => Effect.die("unused"),
        read: () => Effect.succeed(null),
        remove: () => Effect.void,
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  let stepsWithPending = 0;
  let steps = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const lines = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* OrchestrationEventStore;
        const pipeline = yield* OrchestrationProjectionPipeline;
        const output: string[] = [];
        const stream = makeProjectionEventStream(seed, eventsPerSeed);
        for (const [index, event] of stream.entries()) {
          yield* applyProjectionStreamEvent(store, pipeline, event, `${seed}-${index}`);
          const pending = yield* maxPendingCounts;
          steps += 1;
          if (pending.approvals > 0 || pending.userInputs > 0) stepsWithPending += 1;
          output.push(
            `step ${seed}:${index}:${event.label}:${hashDump(yield* dumpNarrowWriteProjections)}`,
          );
        }
        return output;
      }).pipe(Effect.provide(layer), Effect.scoped),
    );
    console.log(lines.join("\n"));
  }
  console.error(JSON.stringify({ seeds, eventsPerSeed, steps, stepsWithPending }));
}
