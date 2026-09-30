import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { createHash } from "node:crypto";
import { materializeCodexShadowHome } from "../provider/Drivers/CodexHomeLayout.ts";
import { forkClaudeNative, verifyClaudeNative } from "./claudeNativeFork.ts";
import { stat } from "node:fs/promises";
import {
  CommandId,
  MessageId,
  ThreadId,
  TurnId,
  RuntimeSessionId,
  ProviderDriverKind,
  ProviderInstanceId,
  OrchestrationCommand,
  SessionImportError,
  type SessionImportInput,
  type SessionImportDiscoverInput,
  type SessionImportPage,
  type SessionImportResult,
  type SessionImportSource,
  type SessionImportStore,
  type SessionImportReconcileInput,
  type SessionImportRecovery,
  type SessionImportAdoptInput,
} from "@ryco/contracts";
import { Context, Effect, Layer, Option, Schema, Semaphore, FileSystem, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as CodexClient from "effect-codex-app-server/client";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ServerSettingsService } from "../serverSettings.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationCommandAdmissionError } from "../orchestration/Errors.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkspaceAccessPolicy } from "../workspace/Services/WorkspaceAccessPolicy.ts";
import { buildCodexInitializeParams } from "../provider/Layers/CodexProvider.ts";
import { resolveProviderSourceLayout } from "../provider/ProviderSourceLayout.ts";
import { makeForkScanner, nativeContext, type ForkCandidate } from "./forkReconciliation.ts";
import {
  discoverFiles,
  parseHistory,
  readSource,
  sourceKey,
  sourceStamp,
  IMPORT_LIMITS,
  type SourceHistory,
} from "./sourceHistory.ts";
import { realpath } from "node:fs/promises";

class ForkMismatch extends Schema.TaggedError<ForkMismatch>()("SessionImportForkMismatch", {
  message: Schema.String,
}) {}
const mismatch = (message: string) => new ForkMismatch({ message });
const failure = (message: string) => new SessionImportError({ message });
const io = <A>(run: () => Promise<A>, message: string) =>
  Effect.tryPromise({ try: run, catch: () => failure(message) });
export interface SessionImportShape {
  readonly sources: (input: {
    source: SessionImportSource;
  }) => Effect.Effect<readonly SessionImportStore[], SessionImportError>;
  readonly reconcile: (
    input: SessionImportReconcileInput,
  ) => Effect.Effect<SessionImportRecovery, SessionImportError>;
  readonly adopt: (
    input: SessionImportAdoptInput,
  ) => Effect.Effect<SessionImportResult, SessionImportError>;
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
const importLocks = new WeakMap<SqlClient.SqlClient, Semaphore.Semaphore>();
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
  native_file: string | null;
  native_fingerprint: string | null;
}
export interface SessionImportTestOptions {
  readonly rootForSource?: (source: "codex" | "claudeAgent") => string;
  readonly verifyNative?: (input: {
    source: SessionImportSource;
    candidate: ForkCandidate;
    cwd: string;
    root: string;
    sourceId: string;
  }) => Promise<void>;
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
    const lock = importLocks.get(sql) ?? (yield* Semaphore.make(1));
    importLocks.set(sql, lock);
    const scanner = makeForkScanner();
    const normalize = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.mapError((error) =>
          Schema.is(SessionImportError)(error)
            ? error
            : Schema.is(ForkMismatch)(error)
              ? failure(error.message)
              : failure(
                  "Local import verification failed. Inspect again when the provider is idle.",
                ),
        ),
      );
    const assertUnrestricted = () =>
      policy.isRestricted
        ? Effect.fail(
            failure("Local history import is unavailable on a workspace-restricted server."),
          )
        : Effect.void;
    const layoutFor = (
      source: SessionImportSource,
      config?: Parameters<typeof resolveProviderSourceLayout>[1],
    ) =>
      resolveProviderSourceLayout(source, config).pipe(
        Effect.provideService(Path.Path, pathService),
      );
    const stores = (source: SessionImportSource) =>
      Effect.gen(function* () {
        yield* assertUnrestricted();
        const configs = deriveProviderInstanceConfigMap(yield* settings.getSettings);
        const entries = new Map<string, SessionImportStore & { root: string }>();
        const declarations = [
          ["", undefined],
          ...Object.entries(configs).filter(([, config]) => config.driver === source),
        ] as const;
        if (declarations.length > IMPORT_LIMITS.sources)
          return yield* failure("The configured source declarations exceed the discovery limit.");
        for (const [id, config] of declarations) {
          const resolved = yield* Effect.result(layoutFor(source, config));
          if (resolved._tag === "Failure") continue;
          const layout = resolved.success;
          const root = yield* io(
            () => realpath(options.rootForSource?.(source) ?? layout.root),
            "Configured provider store is unavailable.",
          ).pipe(Effect.catch(() => Effect.succeed(null)));
          if (!root) continue;
          const key = sourceKey(source, root, "store");
          const previous = entries.get(key);
          entries.set(key, {
            key,
            root,
            isDefault: previous?.isDefault === true || !id,
            label: previous?.label ?? (id ? config?.displayName || id : "Default store"),
            instanceIds: [
              ...(previous?.instanceIds ?? []),
              ...(id && layout.enabled !== false ? [ProviderInstanceId.make(id)] : []),
            ],
          });
        }
        return [...entries.values()];
      });
    const selectedStore = (source: SessionImportSource, storeKey?: string) =>
      Effect.gen(function* () {
        const available = yield* stores(source);
        if (storeKey) {
          const selected = available.find((store) => store.key === storeKey);
          if (!selected)
            return yield* failure(
              "The chosen source store changed or is unavailable. Discover again.",
            );
          return selected;
        }
        const layout = yield* layoutFor(source);
        const root = yield* io(
          () => realpath(options.rootForSource?.(source) ?? layout.root),
          "Default provider history is unavailable.",
        );
        return available.find((store) => store.root === root)!;
      });
    const sources: SessionImportShape["sources"] = (input) =>
      normalize(
        stores(input.source).pipe(
          Effect.map((items) => items.map(({ root: _root, ...store }) => store)),
        ),
      );
    const withCodex = <A, E>(
      layout: NonNullable<Effect.Success<ReturnType<typeof resolveProviderSourceLayout>>["codex"]>,
      cwd: string,
      environment: NodeJS.ProcessEnv,
      binaryPath: string,
      use: (client: CodexClient.CodexAppServerClient["Service"]) => Effect.Effect<A, E>,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            CodexClient.layerCommand({
              command: binaryPath,
              args: ["app-server"],
              cwd,
              env: {
                ...environment,
                CODEX_HOME: layout.effectiveHomePath ?? layout.sharedHomePath,
              },
            }),
          ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
          const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
            Effect.provide(context),
          );
          const initialized = yield* client.request("initialize", buildCodexInitializeParams());
          const actualHome = yield* io(
            () => realpath(initialized.codexHome),
            "Codex effective home is unavailable.",
          );
          const expectedHome = yield* io(
            () => realpath(layout.effectiveHomePath ?? layout.sharedHomePath),
            "Codex expected home is unavailable.",
          );
          if (actualHome !== expectedHome)
            return yield* mismatch("Codex started in a different provider store.");
          yield* client.notify("initialized", undefined);
          return yield* use(client);
        }),
      ).pipe(
        Effect.timeout("45 seconds"),
        Effect.mapError((error) =>
          Schema.is(ForkMismatch)(error)
            ? error
            : failure("Codex native history verification failed."),
        ),
      );

    const targetCwd = (workspaceRoot: string) =>
      Effect.gen(function* () {
        const cwd = yield* policy.assertExistingPath({
          path: workspaceRoot,
          operation: "session import",
        });
        const canonical = yield* io(() => realpath(cwd), "The target folder is unavailable.");
        if (
          canonical !== cwd ||
          !(yield* io(() => stat(canonical), "The target folder is unavailable.")).isDirectory()
        )
          return yield* failure(
            "Choose an existing canonical target folder so native continuation uses the same project store.",
          );
        return canonical;
      });

    const recoveryContext = (
      input: { key: string; source: SessionImportSource },
      phase = "forking",
      reusableSource?: Awaited<ReturnType<typeof readSource>>,
    ) =>
      Effect.gen(function* () {
        yield* assertUnrestricted();
        const saved =
          (yield* sql<SavedImport>`SELECT * FROM session_imports WHERE source_key = ${input.key}`)[0];
        if (!saved || saved.source !== input.source || saved.completed || saved.phase !== phase)
          return yield* failure("This item does not have an uncertain native fork to inspect.");
        const command = yield* Schema.decodeUnknownEffect(OrchestrationCommand)(
          JSON.parse(saved.command_json),
        );
        if (command.type !== "thread.history.import")
          return yield* failure("Invalid saved import.");
        const config = deriveProviderInstanceConfigMap(yield* settings.getSettings)[
          ProviderInstanceId.make(saved.instance_id)
        ];
        if (!config)
          return yield* failure(
            "The pinned provider configuration is unavailable. Restore it before recovery.",
          );
        const fingerprint = createHash("sha256").update(JSON.stringify(config)).digest("hex");
        const project = yield* snapshots.getProjectShellById(
          SessionImportInputProjectId.make(saved.project_id),
        );
        if (
          !config ||
          config.driver !== input.source ||
          config.enabled === false ||
          fingerprint !== saved.provider_fingerprint ||
          Option.isNone(project) ||
          (yield* targetCwd(project.value.workspaceRoot)) !== saved.target_cwd
        )
          return yield* failure(
            "The pinned target or provider configuration changed. Restore it before recovery.",
          );
        const layout = yield* layoutFor(input.source, config);
        const root = yield* io(
          () => realpath(options.rootForSource?.(input.source) ?? layout.root),
          "Pinned provider store is unavailable.",
        );
        if (root !== saved.source_root)
          return yield* failure("The pinned source store changed. Recovery remains paused.");
        if (
          reusableSource &&
          (yield* io(() => sourceStamp(saved.source_file), "Pinned source changed.")) !==
            reusableSource.stamp
        )
          return yield* failure("The original source changed during verification.");
        const source =
          reusableSource ??
          (yield* io(() => readSource(root, saved.source_file), "Pinned source is unavailable."));
        const history = yield* Effect.try({
          try: () => parseHistory(input.source, source.contents),
          catch: () => failure("Pinned source is incomplete."),
        });
        if (
          source.fingerprint !== saved.source_fingerprint ||
          sourceKey(input.source, root, history.id) !== input.key
        )
          return yield* failure(
            "The original source changed. Recovery remains paused to avoid mismatched history.",
          );
        return {
          saved,
          command,
          config,
          layout,
          root,
          source,
          history,
          pinned: JSON.stringify([
            saved.source_fingerprint,
            saved.provider_fingerprint,
            saved.target_cwd,
            root,
          ]),
        };
      });
    const verifyCopy = (
      context: Effect.Success<ReturnType<typeof recoveryContext>>,
      candidate: ForkCandidate,
    ) =>
      Effect.gen(function* () {
        const { saved, layout, history, root, source } = context;
        const copied =
          candidate.read ??
          (yield* io(() => readSource(root, candidate.file), "Native copy is unavailable."));
        if (
          (yield* io(() => sourceStamp(candidate.file), "Native copy is unavailable.")) !==
          copied.stamp
        )
          return yield* failure("Native copy changed during verification.");
        if (
          copied.fingerprint !== candidate.fingerprint ||
          candidate.history.id === history.id ||
          candidate.history.forkedFromId !== history.id ||
          nativeContext(saved.source as SessionImportSource, copied.contents) !==
            nativeContext(saved.source as SessionImportSource, source.contents)
        )
          return yield* mismatch(
            "The candidate is not an unchanged compatible fork of the original source.",
          );
        if (options.verifyNative) {
          yield* io(
            () =>
              options.verifyNative!({
                source: saved.source as SessionImportSource,
                candidate,
                cwd: saved.target_cwd,
                root,
                sourceId: history.id,
              }),
            "Native candidate verification failed.",
          );
        } else if (saved.source === "codex") {
          yield* withCodex(
            layout.codex!,
            saved.target_cwd,
            layout.environment,
            layout.binaryPath,
            (client) =>
              Effect.gen(function* () {
                const { thread } = yield* client.request("thread/read", {
                  threadId: candidate.history.id,
                  includeTurns: true,
                });
                const nativeFile = thread.path
                  ? yield* io(() => realpath(thread.path!), "Codex native path is unavailable.")
                  : null;
                if (
                  thread.id !== candidate.history.id ||
                  thread.forkedFromId !== history.id ||
                  thread.cwd !== saved.target_cwd ||
                  nativeFile !== candidate.file ||
                  thread.ephemeral ||
                  thread.status.type === "active" ||
                  thread.status.type === "systemError" ||
                  !thread.turns.length ||
                  thread.turns.some(
                    (turn) =>
                      turn.status !== "completed" ||
                      turn.itemsView === "notLoaded" ||
                      turn.itemsView === "summary",
                  )
                )
                  return yield* mismatch(
                    "Codex copy has incompatible provenance, target, or incomplete native turns.",
                  );
              }),
          );
        } else {
          const compatible = yield* io(
            () =>
              verifyClaudeNative({
                root,
                environment: layout.environment,
                cwd: saved.target_cwd,
                candidateId: candidate.history.id,
                candidateFile: candidate.file,
              }),
            "Claude native verification is unavailable.",
          );
          if (!compatible)
            return yield* mismatch("Claude copy is not complete in the pinned target store.");
        }
        if (
          (yield* io(
            () => sourceStamp(candidate.file),
            "Native copy changed during verification.",
          )) !== copied.stamp ||
          (yield* io(
            () => sourceStamp(saved.source_file),
            "Original source changed during verification.",
          )) !== source.stamp
        )
          return yield* failure("Native copy or source changed during verification.");
      });
    const copiedCandidate = (context: Effect.Success<ReturnType<typeof recoveryContext>>) =>
      Effect.gen(function* () {
        const { saved, root } = context;
        const cursor = JSON.parse(saved.cursor_json);
        const nativeId = saved.source === "codex" ? cursor.threadId : cursor.resume;
        if (typeof nativeId !== "string" || nativeId === context.history.id)
          return yield* failure("The saved native identity is not an independent copy.");
        let file = saved.native_file;
        if (!file) {
          // Upgrade older successful copies and bind newly returned identities
          // using only a bounded catalog in their pinned canonical store.
          const catalog = yield* io(
            () => discoverFiles(saved.source as SessionImportSource, root, true),
            "Saved native copy discovery is unavailable.",
          );
          const matches = catalog.files.filter(
            (entry) => entry.key === sourceKey(saved.source as SessionImportSource, root, nativeId),
          );
          if (catalog.capped || catalog.blocked || matches.length !== 1)
            return yield* failure(
              "The bounded catalog cannot prove the saved copy's location. Import remains paused.",
            );
          file = matches[0]!.file;
        }
        const read = yield* io(() => readSource(root, file), "Saved native copy is unavailable.");
        const history = yield* Effect.try({
          try: () => parseHistory(saved.source as SessionImportSource, read.contents),
          catch: () => failure("Saved native copy is incomplete."),
        });
        if (
          history.id !== nativeId ||
          (saved.native_fingerprint && read.fingerprint !== saved.native_fingerprint)
        )
          return yield* failure(
            "Saved native copy changed before publication. Import remains paused.",
          );
        return { file, fingerprint: read.fingerprint, history, read } satisfies ForkCandidate;
      });
    const revalidatePublicationCopy = (
      input: { key: string; source: SessionImportSource },
      verified: {
        context: Effect.Success<ReturnType<typeof recoveryContext>>;
        candidate: ForkCandidate;
      },
    ) =>
      Effect.gen(function* () {
        const current = yield* recoveryContext(input, "copied", verified.context.source);
        if (
          current.saved.cursor_json !== verified.context.saved.cursor_json ||
          current.saved.command_json !== verified.context.saved.command_json ||
          (current.saved.native_file && current.saved.native_file !== verified.candidate.file) ||
          (current.saved.native_fingerprint &&
            current.saved.native_fingerprint !== verified.candidate.fingerprint)
        )
          return yield* failure("Saved copy admission changed. Retry its pinned selection.");
        if (
          (yield* io(() => sourceStamp(verified.candidate.file), "Saved native copy changed.")) !==
          verified.candidate.read!.stamp
        )
          return yield* failure(
            "Saved native copy changed before publication. Import remains paused.",
          );
      });
    const verifiedPublicationCopy = (input: { key: string; source: SessionImportSource }) =>
      Effect.gen(function* () {
        const context = yield* recoveryContext(input, "copied");
        const candidate = yield* copiedCandidate(context);
        yield* verifyCopy(context, candidate);
        const verified = { context, candidate };
        yield* revalidatePublicationCopy(input, verified);
        const updated =
          yield* sql`UPDATE session_imports SET native_file = ${candidate.file}, native_fingerprint = ${candidate.fingerprint} WHERE source_key = ${input.key} AND phase = 'copied' AND cursor_json = ${context.saved.cursor_json} AND command_json = ${context.saved.command_json} RETURNING source_key`;
        if (!updated.length)
          return yield* failure(
            "Saved import changed before publication. Retry its pinned selection.",
          );
        return verified;
      });
    const reconcile: SessionImportShape["reconcile"] = (input) =>
      normalize(
        lock.withPermits(1)(
          Effect.gen(function* () {
            const context = yield* recoveryContext(input);
            const page = yield* io(
              () =>
                scanner.page({
                  ...input,
                  root: context.root,
                  sourceId: context.history.id,
                  pinned: context.pinned,
                  reservedBytes: Buffer.byteLength(context.source.contents),
                  reservedFiles: 1,
                }),
              "Inspection expired or history changed. Inspect again.",
            );
            if (page.result.state !== "unique") return page.result;
            // Native comparison gets its own bounded page when the scan has
            // consumed the remaining read/byte allowance.
            if (
              page.reads >= 50 ||
              page.bytes + page.scan.candidate!.bytes > IMPORT_LIMITS.pageBytes
            )
              return {
                ...page.result,
                state: "scanning" as const,
                nextCursor: page.token,
                notice:
                  "The source scan is complete. Continue to verify the native copy within the next page's budget.",
              };
            const candidate = yield* io(
              () => scanner.candidate(page.token, input.key, context.pinned),
              "Fork evidence changed. Inspect again.",
            );
            const verified = yield* Effect.result(verifyCopy(context, candidate));
            if (verified._tag === "Failure")
              return {
                ...page.result,
                state: Schema.is(ForkMismatch)(verified.failure)
                  ? ("mismatched" as const)
                  : ("unknown" as const),
                notice: Schema.is(ForkMismatch)(verified.failure)
                  ? "The fork does not prove compatible native history in the pinned target store. Import remains paused."
                  : "Native verification is unavailable or changed. The outcome remains unknown and import stays paused.",
              };
            yield* io(
              () => scanner.approve(page.token, input.key, context.pinned),
              "Fork evidence changed during verification. Inspect again.",
            );
            return {
              ...page.result,
              adoptionToken: page.token,
              notice:
                "One compatible native copy is proven. Adopting publishes the saved history and uses this copy for future turns.",
            };
          }),
        ),
      );
    const adopt: SessionImportShape["adopt"] = (input) =>
      normalize(
        Effect.gen(function* () {
          const request = yield* lock.withPermits(1)(
            Effect.gen(function* () {
              yield* assertUnrestricted();
              const previous =
                (yield* sql<SavedImport>`SELECT * FROM session_imports WHERE source_key = ${input.key}`)[0];
              // A durable adoption is replayed using its pinned selection, including
              // after a restart loses all inspection receipts.
              if (previous && previous.source === input.source && previous.phase === "copied") {
                const command = yield* Schema.decodeUnknownEffect(OrchestrationCommand)(
                  JSON.parse(previous.command_json),
                );
                if (command.type !== "thread.history.import")
                  return yield* failure("Invalid saved import.");
                return {
                  source: input.source,
                  key: input.key,
                  projectId: command.projectId,
                  modelSelection: command.modelSelection,
                };
              }
              const context = yield* recoveryContext(input);
              const candidate = yield* io(
                () => scanner.candidate(input.adoptionToken, input.key, context.pinned, true),
                "Fork evidence expired or changed. Inspect again.",
              );
              yield* verifyCopy(context, candidate);
              yield* io(
                () => scanner.validate(input.adoptionToken, input.key, context.pinned),
                "Fork evidence changed during verification. Inspect again.",
              );
              const fresh = yield* recoveryContext(input, "forking", context.source);
              if (fresh.pinned !== context.pinned)
                return yield* failure("Pinned import changed during recovery.");
              const cursor =
                input.source === "codex"
                  ? { threadId: candidate.history.id }
                  : {
                      threadId: context.saved.thread_id,
                      resume: candidate.history.id,
                      turnCount: context.command.messages.filter(
                        (message) => message.role === "user",
                      ).length,
                    };
              const updated =
                yield* sql`UPDATE session_imports SET cursor_json = ${JSON.stringify(cursor)}, native_file = ${candidate.file}, native_fingerprint = ${candidate.fingerprint}, phase = 'copied' WHERE source_key = ${input.key} AND phase = 'forking' AND cursor_json = ${context.saved.cursor_json} RETURNING source_key`;
              if (!updated.length)
                return yield* failure(
                  "Another owner recovered this import. Retry the saved adoption.",
                );
              return {
                source: input.source,
                key: input.key,
                projectId: context.command.projectId,
                modelSelection: context.command.modelSelection,
              };
            }),
          );
          return yield* importSession(request);
        }),
      );
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
        const root = (yield* selectedStore(input.source, input.storeKey)).root;
        const catalog = yield* io(
          () => discoverFiles(input.source, root, input.includeArchived),
          "Provider history is unavailable. Check that the provider has local conversations on this server.",
        );
        const owned = yield* sql<
          Pick<SavedImport, "source_key" | "phase" | "cursor_json">
        >`SELECT source_key, phase, cursor_json FROM session_imports WHERE source = ${input.source} AND source_root = ${root} LIMIT 10001`;
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
            ...(catalog.blocked
              ? [
                  "Linked archive entries were not traversed. Recovery cannot prove uniqueness while they are present.",
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
            const cwd = yield* targetCwd(project.value.workspaceRoot);
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
            if (saved) {
              const layout = yield* layoutFor(input.source, config);
              const root = yield* io(
                () => realpath(options.rootForSource?.(input.source) ?? layout.root),
                "Pinned provider store is unavailable.",
              );
              if (root !== saved.source_root)
                return yield* failure(
                  "The pinned continuation store changed. Restore it before retrying.",
                );
            }
            if (saved && (saved.target_cwd !== cwd || saved.provider_fingerprint !== fingerprint))
              return yield* failure(
                "The target folder or provider configuration changed. Restore the original selection before retrying.",
              );
            if (!saved || saved.phase === "prepared") {
              // A prepared intent has not started a native operation. Retain its
              // command and canonical source selection rather than deleting it
              // before discovery can fail or default to another configured store.
              const store = saved
                ? { root: saved.source_root }
                : yield* selectedStore(input.source, input.storeKey);
              if (saved && input.storeKey) {
                const selected = yield* selectedStore(input.source, input.storeKey);
                if (selected.root !== saved.source_root)
                  return yield* failure("Retry with the original source store.");
              }
              const root = store.root;
              const providerLayout = yield* layoutFor(input.source, config);
              const configuredRoot = yield* io(
                () => realpath(options.rootForSource?.(input.source) ?? providerLayout.root),
                "Continuation store is unavailable.",
              );
              if (configuredRoot !== root)
                return yield* failure(
                  "Choose a continuation instance using the selected source store.",
                );
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
              if (
                saved &&
                (source.file !== saved.source_file || read.fingerprint !== saved.source_fingerprint)
              )
                return yield* failure(
                  "The prepared source changed. Restore the original before retrying.",
                );
              const threadId = ThreadId.make(saved?.thread_id ?? `import-${input.key}`);
              const now = new Date().toISOString();
              let turn = 0;
              const command: OrchestrationCommand = saved
                ? yield* Schema.decodeUnknownEffect(OrchestrationCommand)(
                    JSON.parse(saved.command_json),
                  )
                : {
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
              if (saved && command.type === "thread.history.import")
                turn = command.messages.filter((message) => message.role === "user").length;
              const commandJson = saved?.command_json ?? JSON.stringify(command);
              if (!saved)
                yield* sql`INSERT INTO session_imports (source_key, source, thread_id, project_id, command_json, cursor_json, instance_id, phase, target_cwd, provider_fingerprint, source_root, source_file, source_fingerprint) VALUES (${input.key}, ${input.source}, ${threadId}, ${projectId}, ${JSON.stringify(command)}, '{}', ${input.modelSelection.instanceId}, 'prepared', ${cwd}, ${fingerprint}, ${root}, ${source.file}, ${read.fingerprint})`;
              const markForking = () =>
                Effect.gen(function* () {
                  const claimed =
                    yield* sql`UPDATE session_imports SET phase = 'forking' WHERE source_key = ${input.key} AND phase = 'prepared' AND command_json = ${commandJson} RETURNING source_key`;
                  if (!claimed.length)
                    return yield* failure(
                      "Another owner started this import. Refresh before retrying.",
                    );
                });
              let nativeId: string;
              if (options.fork) {
                yield* markForking();
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
                const layout = providerLayout.codex!;
                yield* materializeCodexShadowHome(layout).pipe(
                  Effect.provideService(Path.Path, pathService),
                  Effect.provideService(FileSystem.FileSystem, fileSystem),
                );
                nativeId = yield* withCodex(
                  layout,
                  cwd,
                  providerLayout.environment,
                  providerLayout.binaryPath,
                  (client) =>
                    Effect.gen(function* () {
                      const sourceThread = yield* client.request("thread/read", {
                        threadId: history.id,
                        includeTurns: true,
                      });
                      const last = sourceThread.thread.turns.at(-1);
                      if (!last || last.status !== "completed")
                        return yield* failure(
                          "Codex must have a completed final turn before import.",
                        );
                      yield* markForking();
                      const fork = yield* client.request("thread/fork", {
                        threadId: history.id,
                        lastTurnId: last.id,
                        cwd,
                        ephemeral: false,
                      });
                      return fork.thread.id;
                    }),
                );
              } else {
                yield* markForking();
                nativeId = yield* io(
                  () =>
                    forkClaudeNative({
                      root,
                      environment: providerLayout.environment,
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
              // Persist the returned identity before any further I/O. Failure
              // after this point must retry this exact copy, never fork again.
              yield* sql`UPDATE session_imports SET cursor_json = ${JSON.stringify(cursor)}, phase = 'copied' WHERE source_key = ${input.key} AND phase = 'forking' AND command_json = ${commandJson}`;
              saved =
                (yield* sql<SavedImport>`SELECT * FROM session_imports WHERE source_key = ${input.key}`)[0]!;
            }
            const command = yield* Schema.decodeUnknownEffect(OrchestrationCommand)(
              JSON.parse(saved.command_json),
            );
            // Completed receipts bypass admission and never reset a live cursor.
            const existing = yield* snapshots.getThreadShellById(ThreadId.make(saved.thread_id));
            if (Option.isNone(existing)) {
              const verified = yield* verifiedPublicationCopy(input);
              // The engine executes this wrapper in its own serialized fiber,
              // so cancellation/queue delay cannot release the settings lock
              // early or admit a stale project snapshot. Binding and projection
              // share the same SQL transaction; rejected admission is retryable.
              yield* engine.dispatch(command, {
                withCommitLease: settings.withSettingsSnapshot,
                admit: (commit) =>
                  sql
                    .withTransaction(
                      Effect.gen(function* () {
                        const admission = revalidatePublicationCopy(input, verified);
                        yield* admission;
                        yield* directory.upsert({
                          threadId: ThreadId.make(saved.thread_id),
                          provider: ProviderDriverKind.make(saved.source),
                          providerInstanceId: ProviderInstanceId.make(saved.instance_id),
                          runtimeSessionId: RuntimeSessionId.make(`import-${input.key}`),
                          status: "stopped",
                          runtimeMode: "approval-required",
                          resumeCursor: JSON.parse(saved.cursor_json),
                          runtimePayload: { cwd: verified.context.saved.target_cwd },
                        });
                        yield* admission;
                      }).pipe(
                        Effect.mapError(
                          () =>
                            new OrchestrationCommandAdmissionError({
                              detail:
                                "Pinned import changed before publication. Restore its source, copy, provider and target before retrying.",
                            }),
                        ),
                        Effect.andThen(commit),
                      ),
                    )
                    .pipe(
                      Effect.catchTag("SqlError", () =>
                        Effect.fail(
                          new OrchestrationCommandAdmissionError({
                            detail: "Import publication was interrupted. Retry its saved copy.",
                          }),
                        ),
                      ),
                    ),
              });
            } else {
              yield* engine.dispatch(command);
            }
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
    return { sources, discover, importSession, reconcile, adopt } satisfies SessionImportShape;
  });
// Kept separate to ensure persisted identifiers pass the same boundary as RPC input.
import { ProjectId as SessionImportInputProjectId } from "@ryco/contracts";
export const SessionImportLive = Layer.effect(SessionImport, makeSessionImport());
