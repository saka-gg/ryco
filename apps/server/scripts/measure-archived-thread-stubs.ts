/**
 * Measures the shell snapshot with archived threads as full shells versus stubs
 * (`archivedThreads: "stub"`); run with Node (server runtime):
 *
 *   node apps/server/scripts/measure-archived-thread-stubs.ts [--threads 2000] [--archived 0.6]
 *     [--runs 9] [--out results.json]
 *
 * Seeds an in-memory projection with `--threads` threads (each with a session and a completed
 * latest turn), `--archived` of them archived, and reports per form (medians of `--runs`):
 * - buildMs: one shell snapshot build (`getShellSnapshot` / `getStubbedShellSnapshot`);
 * - pageEncodeMs: paging plus the RPC layer's encode and JSON.stringify of every message;
 * - decodeMs: JSON.parse plus the client's schema decode of every message;
 * - assembleApplyMs: reassembly plus `syncServerShellSnapshot` into an empty store;
 * - bytes / deflatedBytes: all messages' JSON, raw and deflated (permessage-deflate).
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { deflateRawSync } from "node:zlib";

import { syncServerShellSnapshot } from "@ryco/client-runtime/state/threads";
import { EnvironmentId, OrchestrationShellStreamItem } from "@ryco/contracts";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { RpcSerialization } from "effect/rpc";
import * as SqlClient from "effect/sql/SqlClient";

import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import {
  ProjectionSnapshotQuery,
  readStubbedShellSnapshot,
} from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../src/orchestration/ThreadBackgroundLiveness.ts";
import { SqlitePersistenceMemory } from "../src/persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolver } from "../src/project/Services/RepositoryIdentityResolver.ts";
import { pageShellSnapshot } from "../src/ws/context/shellSnapshotPages.ts";
// A deep path: the client's own reassembly is not part of `@ryco/client-runtime/rpc`.
import { createShellSnapshotAssembler } from "@ryco/client-runtime/rpc/shellSnapshotAssembly";

const { values: args } = parseArgs({
  options: {
    threads: { type: "string", default: "2000" },
    archived: { type: "string", default: "0.6" },
    runs: { type: "string", default: "9" },
    out: { type: "string" },
  },
});
const THREADS = Number(args.threads);
const ARCHIVED = Number(args.archived);
const RUNS = Number(args.runs);

const median = (values: ReadonlyArray<number>) =>
  values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)]!;
const round = (value: number) => Math.round(value * 10) / 10;
const timeMs = (run: () => void) => {
  const started = performance.now();
  run();
  return performance.now() - started;
};

const MODEL =
  '{"instanceId":"codex","model":"gpt-5-codex","options":[{"id":"reasoningEffort","value":"high"}]}';

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const at = (minute: number) => new Date(Date.UTC(2026, 8, 1) + minute * 60_000).toISOString();
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json, scripts_json,
      created_at, updated_at
    ) VALUES ('project-bench', 'Bench', '/Users/bench/code/ryco', ${MODEL}, '[]', ${at(0)}, ${at(0)})
  `;
  const archivedCount = Math.round(THREADS * ARCHIVED);
  for (let index = 0; index < THREADS; index += 1) {
    const id = `thread-${String(index).padStart(5, "0")}`;
    const archived = index < archivedCount;
    const created = at(index);
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        branch, worktree_path, created_at, updated_at, archived_at, latest_user_message_at,
        latest_turn_id, lineage_parent_thread_id, lineage_root_thread_id, lineage_relationship
      ) VALUES (
        ${id}, 'project-bench', ${`Refactor the shell snapshot pipeline step ${index}`}, ${MODEL},
        'full-access', 'default', ${`ryco/feature-${index}`},
        ${`/Users/bench/.ryco/worktrees/ryco/feature-${index}`}, ${created}, ${at(index + 30)},
        ${archived ? at(index + 60) : null}, ${at(index + 20)}, ${`turn-${index}`},
        ${index % 10 === 0 && index > 0 ? "thread-00000" : null},
        ${index % 10 === 0 && index > 0 ? "thread-00000" : null},
        ${index % 10 === 0 && index > 0 ? "delegated" : null}
      )
    `;
    yield* sql`
      INSERT INTO projection_turns (
        thread_id, turn_id, pending_message_id, assistant_message_id, state, requested_at,
        started_at, completed_at, checkpoint_files_json
      ) VALUES (
        ${id}, ${`turn-${index}`}, ${`message-user-${index}`}, ${`message-assistant-${index}`},
        'completed', ${at(index + 20)}, ${at(index + 21)}, ${at(index + 29)}, '[]'
      )
    `;
    yield* sql`
      INSERT INTO projection_thread_sessions (
        thread_id, status, provider_name, provider_instance_id, runtime_session_id,
        runtime_mode, updated_at
      ) VALUES (
        ${id}, 'stopped', 'codex', 'codex', ${`runtime-${index}`}, 'full-access', ${at(index + 30)}
      )
    `;
  }
});

const runtime = ManagedRuntime.make(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(
      Layer.succeed(RepositoryIdentityResolver, { resolve: () => Effect.die("no git") }),
    ),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const itemsCodec = RpcSerialization.json.codecFor(
  Schema.NonEmptyArray(OrchestrationShellStreamItem),
);
const encodeItems = Schema.encodeUnknownSync(itemsCodec);
const decodeItems = Schema.decodeUnknownSync(itemsCodec);
const environmentId = EnvironmentId.make("environment-bench");

async function measure(form: "full" | "stub") {
  const build = Effect.gen(function* () {
    const query = yield* ProjectionSnapshotQuery;
    return form === "full"
      ? yield* query.getShellSnapshot()
      : yield* readStubbedShellSnapshot(query);
  });
  const buildMs: number[] = [];
  let snapshot = await runtime.runPromise(build);
  for (let run = 0; run < RUNS; run += 1) {
    const started = performance.now();
    snapshot = await runtime.runPromise(build);
    buildMs.push(performance.now() - started);
  }
  let wire: string[] = [];
  const pageEncodeMs: number[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    pageEncodeMs.push(
      timeMs(() => {
        wire = pageShellSnapshot(snapshot).map((message) => JSON.stringify(encodeItems(message)));
      }),
    );
  }
  let decoded: OrchestrationShellStreamItem[][] = [];
  const decodeMs: number[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    decodeMs.push(
      timeMs(() => {
        decoded = wire.map((json) => [...decodeItems(JSON.parse(json))]);
      }),
    );
  }
  const assembleApplyMs: number[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    assembleApplyMs.push(
      timeMs(() => {
        const assembler = createShellSnapshotAssembler();
        for (const item of decoded.flat()) {
          const delivered = assembler.accept(item);
          if (delivered?.kind === "snapshot") {
            syncServerShellSnapshot(
              { activeEnvironmentId: null, environmentStateById: {} },
              delivered.snapshot,
              environmentId,
            );
          }
        }
      }),
    );
  }
  const bytes = wire.reduce((total, json) => total + Buffer.byteLength(json), 0);
  const deflatedBytes = wire.reduce((total, json) => total + deflateRawSync(json).length, 0);
  return {
    form,
    messages: wire.length,
    bytes,
    deflatedBytes,
    buildMs: round(median(buildMs)),
    pageEncodeMs: round(median(pageEncodeMs)),
    decodeMs: round(median(decodeMs)),
    assembleApplyMs: round(median(assembleApplyMs)),
  };
}

await runtime.runPromise(seed);
// One pass of each form warms the JIT; the second pass is reported.
await measure("full");
await measure("stub");
const results = {
  threads: THREADS,
  archivedShare: ARCHIVED,
  runs: RUNS,
  forms: [await measure("full"), await measure("stub")],
};
await runtime.dispose();
const output = JSON.stringify(results, null, 2);
console.log(output);
if (args.out) writeFileSync(args.out, `${output}\n`);
