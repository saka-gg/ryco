import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { createHash } from "node:crypto";
import {
  resolveCodexHomeLayout,
  materializeCodexShadowHome,
} from "../provider/Drivers/CodexHomeLayout.ts";
import { forkClaudeNative } from "./claudeNativeFork.ts";
import { homedir } from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";
import {
  CommandId,
  MessageId,
  ThreadId,
  TurnId,
  RuntimeSessionId,
  ProviderDriverKind,
  ProviderInstanceId,
  CodexSettings,
  ClaudeSettings,
  OrchestrationCommand,
  SessionImportError,
  type SessionImportInput,
  type SessionImportDiscoverInput,
  type SessionImportPage,
  type SessionImportResult,
} from "@ryco/contracts";
import { Context, Effect, Layer, Option, Schema, Semaphore, FileSystem, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as CodexClient from "effect-codex-app-server/client";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ServerSettingsService } from "../serverSettings.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkspaceAccessPolicy } from "../workspace/Services/WorkspaceAccessPolicy.ts";
import { buildCodexInitializeParams } from "../provider/Layers/CodexProvider.ts";
import { expandHomePath } from "../pathExpansion.ts";
import {
  discoverFiles,
  parseHistory,
  readSource,
  sourceKey,
  IMPORT_LIMITS,
  type SourceHistory,
} from "./sourceHistory.ts";
import { realpath } from "node:fs/promises";

const failure = (message: string) => new SessionImportError({ message });
const io = <A>(run: () => Promise<A>, message: string) =>
  Effect.tryPromise({ try: run, catch: () => failure(message) });
export interface SessionImportShape {
  readonly discover: (
    input: SessionImportDiscoverInput,
  ) => Effect.Effect<SessionImportPage, SessionImportError>;
  readonly importSession: (
    input: SessionImportInput,
  ) => Effect.Effect<SessionImportResult, SessionImportError>;
}
export class SessionImport extends Context.Service<SessionImport, SessionImportShape>()(
  "ryco/SessionImport",
) {}
interface SavedImport {
  source_key: string;
  source: string;
  thread_id: string;
  project_id: string;
  command_json: string;
  cursor_json: string;
  instance_id: string;
  completed: number;
  phase: string;
  target_cwd: string;
  provider_fingerprint: string;
  source_root: string;
  source_file: string;
  source_fingerprint: string;
}
const sourceRoot = (source: "codex" | "claudeAgent") =>
  path.resolve(
    expandHomePath(
      source === "codex"
        ? process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex")
        : process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), ".claude"),
    ),
  );

export interface SessionImportTestOptions {
  readonly rootForSource?: (source: "codex" | "claudeAgent") => string;
  readonly fork?: (input: {
    source: "codex" | "claudeAgent";
    sourceId: string;
    cwd: string;
    lastMessageId: string;
  }) => Promise<string>;
}
export const makeSessionImport = (options: SessionImportTestOptions = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const settings = yield* ServerSettingsService;
    const registry = yield* ProviderRegistry;
    const directory = yield* ProviderSessionDirectory;
    const engine = yield* OrchestrationEngineService;
    const snapshots = yield* ProjectionSnapshotQuery;
    const policy = yield* WorkspaceAccessPolicy;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const lock = yield* Semaphore.make(1);
    const metadataCache = new Map<
      string,
      {
        stamp: string;
        history: Pick<SourceHistory, "title" | "cwd" | "id" | "forkedFromId">;
        messageCount: number;
      }
    >();
    const discover: SessionImportShape["discover"] = (input) =>
      Effect.gen(function* () {
        // A restricted node must never expose another directory's historical prompts.
        if (policy.isRestricted)
          return yield* failure(
            "Local history import is unavailable on a workspace-restricted server.",
          );
        const root = (options.rootForSource ?? sourceRoot)(input.source);
        const catalog = yield* io(
          () => discoverFiles(input.source, root, input.includeArchived),
          "Provider history is unavailable. Check that the provider has local conversations on this server.",
        );
        const owned = yield* sql<
          Pick<SavedImport, "source_key" | "phase" | "cursor_json">
        >`SELECT source_key, phase, cursor_json FROM session_imports WHERE source = ${input.source} LIMIT 10001`;
        if (owned.length > 10000)
          return yield* failure("The import ledger exceeds the discovery limit.");
        const quarantinedKeys = new Set(
          owned.filter((row) => row.phase === "forking").map((row) => row.source_key),
        );
        const canonicalRoot = yield* io(() => realpath(root), "Source history is unavailable.");
        const ownedNativeIds = new Set(
          owned.flatMap((row) => {
            try {
              const cursor = JSON.parse(row.cursor_json);
              return [input.source === "codex" ? cursor.threadId : cursor.resume];
            } catch {
              return [];
            }
          }),
        );
        const items: SessionImportPage["items"][number][] = [];
        let skipped = 0,
          consumed = 0,
          bytes = 0;
        const started = Date.now();
        const page = catalog.files.slice(input.offset, input.offset + 50);
        for (const file of page) {
          if (Date.now() - started >= IMPORT_LIMITS.pageMillis) break;
          const result = yield* Effect.result(
            io(async () => {
              const info = await stat(file.file);
              const stamp = `${info.size}:${info.mtimeMs}:${info.ino}`;
              const cached = metadataCache.get(file.key);
              if (cached?.stamp === stamp) return cached;
              if (info.size > IMPORT_LIMITS.bytes) throw new Error("oversized");
              if (bytes + info.size > IMPORT_LIMITS.pageBytes) return null;
              bytes += info.size;
              const read = await readSource(root, file.file);
              const history = parseHistory(input.source, read.contents);
              if (sourceKey(input.source, await realpath(root), history.id) !== file.key)
                throw new Error("identity mismatch");
              const metadata = {
                stamp,
                history: {
                  id: history.id,
                  cwd: history.cwd,
                  title: history.title,
                  forkedFromId: history.forkedFromId,
                },
                messageCount: history.messages.length,
              };
              if (metadataCache.size >= IMPORT_LIMITS.files)
                metadataCache.delete(metadataCache.keys().next().value!);
              metadataCache.set(file.key, metadata);
              return metadata;
            }, "Cannot read this conversation."),
          );
          if (result._tag === "Success" && result.success === null) break;
          consumed++;
          if (result._tag === "Failure") {
            skipped++;
            continue;
          }
          const metadata = result.success!;
          const history = metadata.history;
          if (ownedNativeIds.has(history.id)) continue;
          if (
            history.forkedFromId &&
            quarantinedKeys.has(sourceKey(input.source, canonicalRoot, history.forkedFromId))
          )
            continue;
          if (
            input.search &&
            !`${history.title} ${history.cwd}`.toLowerCase().includes(input.search.toLowerCase())
          )
            continue;
          const saved = yield* sql<
            Pick<SavedImport, "completed" | "thread_id">
          >`SELECT completed, thread_id FROM session_imports WHERE source_key = ${file.key}`;
          items.push({
            key: file.key,
            source: input.source,
            title: history.title,
            cwd: history.cwd,
            archived: file.archived,
            messageCount: metadata.messageCount,
            importedThreadId: saved[0]?.completed ? ThreadId.make(saved[0].thread_id) : null,
            quarantined: quarantinedKeys.has(file.key),
          });
        }
        const next = input.offset + consumed;
        return {
          items,
          nextOffset: next < catalog.files.length ? next : null,
          notices: [
            ...(quarantinedKeys.size
              ? [
                  `${quarantinedKeys.size} import(s) have an uncertain native fork outcome. Only those items and their possible copies are quarantined; other conversations remain available.`,
                ]
              : []),
            ...(catalog.capped
              ? [
                  "Discovery reached its safety limit; only the first 2,000 conversation files are available.",
                ]
              : []),
            ...(skipped
              ? [
                  `${skipped} files were skipped because they are incomplete, malformed, too large, or unsupported. Finish active conversations and retry discovery.`,
                ]
              : []),
          ],
        };
      }).pipe(
        Effect.mapError((error) =>
          Schema.is(SessionImportError)(error)
            ? error
            : failure("Could not discover local histories."),
        ),
      );

    const importSession: SessionImportShape["importSession"] = (input) =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            if (policy.isRestricted)
              return yield* failure(
                "Local history import is unavailable on a workspace-restricted server.",
              );
            let saved =
              (yield* sql<SavedImport>`SELECT * FROM session_imports WHERE source_key = ${input.key}`)[0];
            if (
              saved &&
              (saved.project_id !== input.projectId ||
                saved.instance_id !== input.modelSelection.instanceId ||
                saved.source !== input.source)
            )
              return yield* failure(
                "This import is already assigned to a different target or provider. Retry with its original selection.",
              );
            if (saved && !saved.completed) {
              const pinned = yield* Schema.decodeUnknownEffect(OrchestrationCommand)(
                JSON.parse(saved.command_json),
              );
              if (
                pinned.type !== "thread.history.import" ||
                pinned.modelSelection.model !== input.modelSelection.model
              )
                return yield* failure("Retry with the model selected for the original import.");
            }
            if (saved && saved.phase === "forking")
              return yield* failure(
                "The previous native fork did not return a durable identity. Import is paused to avoid creating duplicate copies. Check provider history before recovery.",
              );
            if (saved?.phase === "prepared") {
              yield* sql`DELETE FROM session_imports WHERE source_key = ${input.key} AND phase = 'prepared'`;
              saved = undefined;
            }
            if (saved?.phase === "source-changed") {
              const retained = saved;
              const checked = yield* io(
                () => readSource(retained.source_root, retained.source_file),
                "Source verification is unavailable. The native copy is retained for retry.",
              );
              if (checked.fingerprint !== saved.source_fingerprint)
                return yield* failure(
                  "The source changed during the native fork. The copy is retained, but import is paused rather than displaying mismatched history.",
                );
              yield* sql`UPDATE session_imports SET phase = 'copied' WHERE source_key = ${input.key}`;
              saved = { ...saved, phase: "copied" };
            }
            if (saved?.completed)
              return { threadId: ThreadId.make(saved.thread_id), alreadyImported: true };
            const projectId = saved
              ? yield* Schema.decodeUnknownEffect(SessionImportInputProjectId)(saved.project_id)
              : input.projectId;
            const project = yield* snapshots.getProjectShellById(projectId);
            if (Option.isNone(project))
              return yield* failure("Choose an existing target project before importing.");
            const cwd = yield* policy.assertExistingPath({
              path: project.value.workspaceRoot,
              operation: "session import",
            });
            if (!(yield* io(() => stat(cwd), "The target folder is unavailable.")).isDirectory())
              return yield* failure("The target must be an existing folder.");
            const config = deriveProviderInstanceConfigMap(yield* settings.getSettings)[
              input.modelSelection.instanceId
            ];
            if (!config || config.driver !== input.source || config.enabled === false)
              return yield* failure("Select an enabled provider instance matching the source.");
            const available = (yield* registry.getProviders).find(
              (provider) => provider.instanceId === input.modelSelection.instanceId,
            );
            if (
              !available ||
              !available.installed ||
              !available.enabled ||
              available.availability === "unavailable" ||
              available.driver !== input.source ||
              !available.models.some((model) => model.slug === input.modelSelection.model)
            )
              return yield* failure(
                "Choose an available model from an installed matching provider. Refresh Providers settings and retry.",
              );
            const fingerprint = createHash("sha256").update(JSON.stringify(config)).digest("hex");
            if (saved && (saved.target_cwd !== cwd || saved.provider_fingerprint !== fingerprint))
              return yield* failure(
                "The target folder or provider configuration changed. Restore the original selection before retrying.",
              );
            if (!saved) {
              const root = (options.rootForSource ?? sourceRoot)(input.source);
              const catalog = yield* io(
                () => discoverFiles(input.source, root, true),
                "Source history is unavailable.",
              );
              const matches = catalog.files.filter((file) => file.key === input.key);
              if (matches.length > 1)
                return yield* failure(
                  "Multiple source files claim this identity. Resolve the duplicate in the provider before importing.",
                );
              const source = matches[0];
              if (!source)
                return yield* failure(
                  "The selected source is no longer available. Discover again.",
                );
              const read = yield* io(
                () => readSource(root, source.file),
                "Source history is unavailable or changed while reading. Retry when idle.",
              );
              const history = yield* Effect.try({
                try: () => parseHistory(input.source, read.contents),
                catch: (error) =>
                  failure(error instanceof Error ? error.message : "Unsupported source history."),
              });
              if (
                sourceKey(
                  input.source,
                  yield* io(() => realpath(root), "Source is unavailable."),
                  history.id,
                ) !== input.key
              )
                return yield* failure("Source identity changed. Discover again.");
              if (history.forkedFromId) {
                const originKey = sourceKey(
                  input.source,
                  yield* io(() => realpath(root), "Source is unavailable."),
                  history.forkedFromId,
                );
                const uncertain =
                  yield* sql`SELECT source_key FROM session_imports WHERE source_key = ${originKey} AND phase = 'forking'`;
                if (uncertain.length)
                  return yield* failure(
                    "This conversation may be a copy from an uncertain import and is quarantined. No additional copy will be created.",
                  );
              }
              const threadId = ThreadId.make(`import-${input.key}`);
              const now = new Date().toISOString();
              let turn = 0;
              const command: OrchestrationCommand = {
                type: "thread.history.import",
                commandId: CommandId.make(`import-${input.key}`),
                threadId,
                projectId,
                title: history.title,
                modelSelection: input.modelSelection,
                runtimeMode: "approval-required",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt: now,
                source: input.source,
                archived: source.archived,
                messages: history.messages.map((message, index) => {
                  if (message.role === "user") turn++;
                  return {
                    ...message,
                    id: MessageId.make(`import:${input.key}:${index}`),
                    turnId: TurnId.make(`import:${input.key}:turn:${turn}`),
                    streaming: false,
                    updatedAt: message.createdAt,
                  };
                }),
              };
              yield* sql`INSERT INTO session_imports (source_key, source, thread_id, project_id, command_json, cursor_json, instance_id, phase, target_cwd, provider_fingerprint, source_root, source_file, source_fingerprint) VALUES (${input.key}, ${input.source}, ${threadId}, ${projectId}, ${JSON.stringify(command)}, '{}', ${input.modelSelection.instanceId}, 'prepared', ${cwd}, ${fingerprint}, ${root}, ${source.file}, ${read.fingerprint})`;
              let nativeId: string;
              if (options.fork) {
                yield* sql`UPDATE session_imports SET phase = 'forking' WHERE source_key = ${input.key}`;
                nativeId = yield* io(
                  () =>
                    options.fork!({
                      source: input.source,
                      sourceId: history.id,
                      cwd,
                      lastMessageId: history.lastMessageId,
                    }),
                  "Native fork failed.",
                );
              } else if (input.source === "codex") {
                const provider = yield* Schema.decodeUnknownEffect(CodexSettings)(
                  config.config ?? {},
                );
                const layout = yield* resolveCodexHomeLayout(provider).pipe(
                  Effect.provideService(Path.Path, pathService),
                );
                const configuredRoot = layout.sharedHomePath;
                if (configuredRoot !== root || (config.environment?.length ?? 0) > 0)
                  return yield* failure(
                    "Choose a Codex instance using this server's default source home without environment overrides.",
                  );
                yield* materializeCodexShadowHome(layout).pipe(
                  Effect.provideService(Path.Path, pathService),
                  Effect.provideService(FileSystem.FileSystem, fileSystem),
                );
                nativeId = yield* Effect.scoped(
                  Effect.gen(function* () {
                    const context = yield* Layer.build(
                      CodexClient.layerCommand({
                        command: provider.binaryPath,
                        args: ["app-server"],
                        cwd,
                        env: {
                          ...process.env,
                          CODEX_HOME: layout.effectiveHomePath ?? process.env.CODEX_HOME ?? root,
                        },
                      }),
                    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
                    const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
                      Effect.provide(context),
                    );
                    yield* client.request("initialize", buildCodexInitializeParams());
                    yield* client.notify("initialized", undefined);
                    const sourceThread = yield* client.request("thread/read", {
                      threadId: history.id,
                      includeTurns: true,
                    });
                    const last = sourceThread.thread.turns.at(-1);
                    if (!last || last.status !== "completed")
                      return yield* failure(
                        "Codex must have a completed final turn before import.",
                      );
                    yield* sql`UPDATE session_imports SET phase = 'forking' WHERE source_key = ${input.key}`;
                    const fork = yield* client.request("thread/fork", {
                      threadId: history.id,
                      lastTurnId: last.id,
                      cwd,
                      ephemeral: false,
                    });
                    return fork.thread.id;
                  }),
                ).pipe(
                  Effect.timeout("45 seconds"),
                  Effect.mapError(() =>
                    failure(
                      "Codex could not fork this conversation. Check the installed provider and retry.",
                    ),
                  ),
                );
              } else {
                const provider = yield* Schema.decodeUnknownEffect(ClaudeSettings)(
                  config.config ?? {},
                );
                if (provider.homePath.trim() || (config.environment?.length ?? 0) > 0)
                  return yield* failure(
                    "Choose a Claude instance using this server's default home without environment overrides.",
                  );
                yield* sql`UPDATE session_imports SET phase = 'forking' WHERE source_key = ${input.key}`;
                nativeId = yield* io(
                  () =>
                    forkClaudeNative({
                      root,
                      sourceFile: source.file,
                      sourceId: history.id,
                      lastMessageId: history.lastMessageId,
                      cwd,
                      key: input.key,
                    }),
                  "Claude could not fork this conversation. Its outcome is uncertain; automatic reforking is disabled.",
                );
              }
              if (nativeId === history.id || !nativeId)
                return yield* failure(
                  "The provider did not create a separate session. Import was stopped.",
                );
              const cursor =
                input.source === "codex"
                  ? { threadId: nativeId }
                  : { threadId, resume: nativeId, turnCount: turn };
              yield* sql`UPDATE session_imports SET cursor_json = ${JSON.stringify(cursor)}, phase = 'source-changed' WHERE source_key = ${input.key}`;
              const after = yield* io(
                () => readSource(root, source.file),
                "Source changed during import. Its copy has been retained.",
              );
              if (after.fingerprint !== read.fingerprint)
                return yield* failure(
                  "Source changed during import. Its copy is retained but mismatched history will not be published.",
                );
              yield* sql`UPDATE session_imports SET phase = 'copied' WHERE source_key = ${input.key}`;
              saved =
                (yield* sql<SavedImport>`SELECT * FROM session_imports WHERE source_key = ${input.key}`)[0]!;
            }
            const command = yield* Schema.decodeUnknownEffect(OrchestrationCommand)(
              JSON.parse(saved.command_json),
            );
            // Binding is persisted before publishing the thread. A crash replays the same command receipt.
            const existing = yield* snapshots.getThreadShellById(ThreadId.make(saved.thread_id));
            if (Option.isNone(existing))
              yield* directory.upsert({
                threadId: ThreadId.make(saved.thread_id),
                provider: ProviderDriverKind.make(saved.source),
                providerInstanceId: ProviderInstanceId.make(saved.instance_id),
                runtimeSessionId: RuntimeSessionId.make(`import-${input.key}`),
                status: "stopped",
                runtimeMode: "approval-required",
                resumeCursor: JSON.parse(saved.cursor_json),
                runtimePayload: { cwd },
              });
            yield* engine.dispatch(command);
            yield* sql`UPDATE session_imports SET completed = 1 WHERE source_key = ${input.key}`;
            return { threadId: ThreadId.make(saved.thread_id), alreadyImported: false };
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            Schema.is(SessionImportError)(error)
              ? error
              : failure("Import could not finish. Retry to recover the saved import."),
          ),
        );
    return { discover, importSession } satisfies SessionImportShape;
  });
// Kept separate to ensure persisted identifiers pass the same boundary as RPC input.
import { ProjectId as SessionImportInputProjectId } from "@ryco/contracts";
export const SessionImportLive = Layer.effect(SessionImport, makeSessionImport());
