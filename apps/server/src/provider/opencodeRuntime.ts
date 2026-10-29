import type {
  ChatAttachment,
  ChatFileAttachment,
  ChatImageAttachment,
  ProviderApprovalDecision,
  RuntimeMode,
} from "@ryco/contracts";
import type {
  Agent,
  FilePartInput,
  PermissionRuleset,
  ProviderListResponse,
  QuestionAnswer,
  QuestionRequest,
} from "@opencode-ai/sdk/v2";
import {
  Cause,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate as P,
  Ref,
  Result,
  Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { isWindowsCommandNotFound } from "../processRunner.ts";
import { isPersistableChatAttachment } from "../attachmentStore.ts";
import type { OpenCodeApi } from "./openCodeApi.ts";
import {
  describeUnsupportedOpenCodeVersion,
  OPENCODE_UNKNOWN_CLI_VERSION_MESSAGE,
} from "./openCodeVersion.ts";
import { collectStreamAsString, parseGenericCliVersion } from "./providerSnapshot.ts";
import { type AgentProcessPriorityShape, spawnAgentProcess } from "./agentProcessPriority.ts";
import { NetService } from "@ryco/shared/Net";
import { timeoutWhileResponsiveOption } from "@ryco/shared/responsiveDeadline";

const OPENCODE_SERVER_READY_PREFIX = "opencode server listening";
const DEFAULT_OPENCODE_SERVER_TIMEOUT_MS = 5_000;
const DEFAULT_HOSTNAME = "127.0.0.1";
const OPENCODE_VERSION_PREFLIGHT_TIMEOUT_MS = 5_000;
/** How long a stopping `opencode serve` group gets after SIGTERM before it is SIGKILLed. */
const OPENCODE_SERVER_TERMINATE_GRACE = "1 second";
export interface OpenCodeServerProcess {
  readonly url: string;
  readonly serverPassword?: string;
  readonly exitCode: Effect.Effect<number, never>;
}

export interface OpenCodeServerConnection {
  readonly url: string;
  readonly serverPassword?: string;
  readonly exitCode: Effect.Effect<number, never> | null;
  readonly external: boolean;
}

const OPENCODE_RUNTIME_ERROR_TAG = "OpenCodeRuntimeError";
export class OpenCodeRuntimeError extends Data.TaggedError(OPENCODE_RUNTIME_ERROR_TAG)<{
  readonly operation: string;
  readonly cause?: unknown;
  readonly detail: string;
}> {
  static readonly is = (u: unknown): u is OpenCodeRuntimeError =>
    P.isTagged(u, OPENCODE_RUNTIME_ERROR_TAG);
}

export function openCodeRuntimeErrorDetail(cause: unknown): string {
  if (OpenCodeRuntimeError.is(cause)) return cause.detail;
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  if (cause && typeof cause === "object") {
    // SDK v2 throws { response, request, error? } shapes — extract what's useful
    const anyCause = cause as Record<string, unknown>;
    const status = (anyCause.response as { status?: number } | undefined)?.status;
    const body = anyCause.error ?? anyCause.data ?? anyCause.body;
    try {
      return `status=${status ?? "?"} body=${JSON.stringify(body ?? cause)}`;
    } catch {
      /* fall through */
    }
  }
  return String(cause);
}

export const runOpenCodeSdk = <A>(
  operation: string,
  fn: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, OpenCodeRuntimeError> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) =>
      new OpenCodeRuntimeError({ operation, detail: openCodeRuntimeErrorDetail(cause), cause }),
  }).pipe(Effect.withSpan(`opencode.${operation}`));

/** A cached `import()` that a failed load does not poison. */
export const lazyOpenCodeModule = <M>(
  name: string,
  load: () => Promise<M>,
): Effect.Effect<M, OpenCodeRuntimeError> => {
  let promise: Promise<M> | undefined;
  return Effect.tryPromise({
    try: () =>
      (promise ??= load().catch((cause: unknown) => {
        promise = undefined;
        throw cause;
      })),
    catch: (cause) =>
      new OpenCodeRuntimeError({
        operation: "createOpenCodeSdkClient",
        detail: `Failed to load OpenCode ${name}: ${openCodeRuntimeErrorDetail(cause)}`,
        cause,
      }),
  }).pipe(Effect.withSpan(`opencode.${name.toLowerCase()}.load`));
};

/**
 * API detection, client creation and the server version check (`openCodeProtocol.ts`) load on
 * first use, outside the boot chunk.
 */
const loadOpenCodeProtocol = lazyOpenCodeModule("protocol", () => import("./openCodeProtocol.ts"));

/**
 * The server's normalised version; fails unless this build runs it on the client's API
 * generation. Every caller runs it before its first mutation.
 */
export const verifyOpenCodeServerVersion = (
  client: OpenCodeApi,
): Effect.Effect<string, OpenCodeRuntimeError> =>
  Effect.flatMap(loadOpenCodeProtocol, (protocol) => protocol.checkOpenCodeServerVersion(client));

/**
 * Runs `<binary> --version` and fails unless it reports an OpenCode version this build can run.
 * Called before every `opencode serve` spawn: Ryco must never start a 2.x server (2.x converts the
 * shared OpenCode database in place and prints a generated password on stdout). Deliberately not
 * cached — a binary swapped on PATH is caught at the next cold start. The only reuse is within one
 * provider probe, which runs this exact check on the same binary moments before it starts its
 * server (`verifiedBinaryVersion`). Ignores the exit code, like the provider probe.
 */
export const assertSupportedOpenCodeBinary = (
  runCommand: OpenCodeRuntimeShape["runOpenCodeCommand"],
  input: { readonly binaryPath: string; readonly environment?: NodeJS.ProcessEnv },
): Effect.Effect<string, OpenCodeRuntimeError> =>
  runCommand({
    binaryPath: input.binaryPath,
    args: ["--version"],
    ...(input.environment !== undefined ? { environment: input.environment } : {}),
  }).pipe(
    Effect.timeoutOption(OPENCODE_VERSION_PREFLIGHT_TIMEOUT_MS),
    Effect.flatMap((result) => {
      if (Option.isNone(result)) {
        return Effect.fail(
          new OpenCodeRuntimeError({
            operation: "startOpenCodeServerProcess",
            detail: `Could not check the OpenCode version: \`${input.binaryPath} --version\` did not finish within ${OPENCODE_VERSION_PREFLIGHT_TIMEOUT_MS / 1_000} seconds.`,
          }),
        );
      }
      const version = parseGenericCliVersion(result.value.stdout);
      if (version === null) {
        return Effect.fail(
          new OpenCodeRuntimeError({
            operation: "startOpenCodeServerProcess",
            detail: OPENCODE_UNKNOWN_CLI_VERSION_MESSAGE,
          }),
        );
      }
      const problem = describeUnsupportedOpenCodeVersion(version, "binary");
      if (problem !== null) {
        return Effect.fail(
          new OpenCodeRuntimeError({ operation: "startOpenCodeServerProcess", detail: problem }),
        );
      }
      return Effect.succeed(version);
    }),
  );

export interface OpenCodeCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface OpenCodeInventory {
  readonly providerList: ProviderListResponse;
  readonly agents: ReadonlyArray<Agent>;
}

export interface ParsedOpenCodeModelSlug {
  readonly providerID: string;
  readonly modelID: string;
}

export interface OpenCodeRuntimeShape {
  /**
   * Spawns a local OpenCode server process. Its lifetime is bound to the caller's
   * `Scope.Scope` — the child is killed automatically when that scope closes.
   * Consumers that want a long-lived server must create and hold a scope explicitly
   * (see {@link Scope.make}) and close it when done.
   */
  readonly startOpenCodeServerProcess: (input: {
    readonly binaryPath: string;
    /**
     * Version the caller verified with `assertSupportedOpenCodeBinary`-equivalent checks for this
     * same binary and environment immediately before; skips the duplicate `--version` spawn.
     */
    readonly verifiedBinaryVersion?: string;
    readonly serverPassword?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
    /** Lowers the server (it runs the agent work); probes leave it unset. */
    readonly processPriority?: AgentProcessPriorityShape | undefined;
  }) => Effect.Effect<OpenCodeServerProcess, OpenCodeRuntimeError, Scope.Scope>;
  /**
   * Returns a handle to either an externally-managed OpenCode server (when
   * `serverUrl` is provided — no lifetime is attached to the caller's scope) or a
   * freshly spawned local server whose lifetime is bound to the caller's scope.
   */
  readonly connectToOpenCodeServer: (input: {
    readonly binaryPath: string;
    readonly verifiedBinaryVersion?: string;
    readonly serverUrl?: string | null;
    readonly serverPassword?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
    /** Lowers a server this call starts; ignored for an external `serverUrl`. */
    readonly processPriority?: AgentProcessPriorityShape | undefined;
  }) => Effect.Effect<OpenCodeServerConnection, OpenCodeRuntimeError, Scope.Scope>;
  readonly runOpenCodeCommand: (input: {
    readonly binaryPath: string;
    readonly args: ReadonlyArray<string>;
    readonly environment?: NodeJS.ProcessEnv;
  }) => Effect.Effect<OpenCodeCommandResult, OpenCodeRuntimeError>;
  /**
   * Detects the server's API generation (read-only requests) before returning a client bound to
   * it; a 2.x server is refused until `OPENCODE_V2_RUNTIME_SUPPORTED`. Not cached: an external
   * server can change generation.
   */
  readonly createOpenCodeSdkClient: (input: {
    readonly baseUrl: string;
    readonly directory: string;
    readonly serverPassword?: string;
  }) => Effect.Effect<OpenCodeApi, OpenCodeRuntimeError>;
  readonly loadOpenCodeInventory: (
    client: OpenCodeApi,
  ) => Effect.Effect<OpenCodeInventory, OpenCodeRuntimeError>;
}

export function resolveOpenCodeServerPassword(input: {
  readonly external: boolean;
  readonly configuredPassword?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): string | undefined {
  if (input.configuredPassword !== undefined) {
    return input.configuredPassword;
  }
  if (input.external) {
    return undefined;
  }
  return input.environment === undefined
    ? process.env.OPENCODE_SERVER_PASSWORD
    : input.environment.OPENCODE_SERVER_PASSWORD;
}

function parseServerUrlFromOutput(output: string): string | null {
  for (const line of output.split("\n")) {
    if (!line.startsWith(OPENCODE_SERVER_READY_PREFIX)) {
      continue;
    }
    const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
    return match?.[1] ?? null;
  }
  return null;
}

export function parseOpenCodeModelSlug(
  slug: string | null | undefined,
): ParsedOpenCodeModelSlug | null {
  if (typeof slug !== "string") {
    return null;
  }

  const trimmed = slug.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return null;
  }

  return {
    providerID: trimmed.slice(0, separator),
    modelID: trimmed.slice(separator + 1),
  };
}

export function openCodeQuestionId(
  index: number,
  question: QuestionRequest["questions"][number],
): string {
  const header = question.header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  return header.length > 0 ? `question-${index}-${header}` : `question-${index}`;
}

export const OPENCODE_NATIVE_ATTACHMENT_MAX_BYTES = 20_000_000;

const OPENCODE_NATIVE_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export function isOpenCodeNativeAttachment(
  attachment: ChatAttachment,
): attachment is ChatImageAttachment | ChatFileAttachment {
  if (!isPersistableChatAttachment(attachment)) {
    return false;
  }
  if (attachment.sizeBytes > OPENCODE_NATIVE_ATTACHMENT_MAX_BYTES) {
    return false;
  }
  if (attachment.type === "image") {
    return OPENCODE_NATIVE_IMAGE_MIME_TYPES.has(attachment.mimeType);
  }
  return attachment.mimeType === "application/pdf" || attachment.mimeType.startsWith("text/");
}

export function toOpenCodeFileParts(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly resolveAttachmentUrl: (attachment: ChatAttachment) => string | null;
}): Array<FilePartInput> {
  const parts: Array<FilePartInput> = [];

  for (const attachment of input.attachments ?? []) {
    const attachmentUrl = input.resolveAttachmentUrl(attachment);
    if (!attachmentUrl) {
      continue;
    }

    parts.push({
      type: "file",
      mime: attachment.mimeType ?? "application/octet-stream",
      filename: attachment.name ?? "attachment",
      url: attachmentUrl,
    });
  }

  return parts;
}

export function buildOpenCodePermissionRules(runtimeMode: RuntimeMode): PermissionRuleset {
  if (runtimeMode === "full-access") {
    return [{ permission: "*", pattern: "*", action: "allow" }];
  }

  return [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "webfetch", pattern: "*", action: "ask" },
    { permission: "websearch", pattern: "*", action: "ask" },
    { permission: "codesearch", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: "*", action: "ask" },
    { permission: "doom_loop", pattern: "*", action: "ask" },
    { permission: "question", pattern: "*", action: "allow" },
  ];
}

export function toOpenCodePermissionReply(
  decision: ProviderApprovalDecision,
): "once" | "always" | "reject" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
      return "always";
    case "decline":
    case "cancel":
    default:
      return "reject";
  }
}

export function toOpenCodeQuestionAnswers(
  request: QuestionRequest,
  answers: Record<string, unknown>,
): Array<QuestionAnswer> {
  return request.questions.map((question, index) => {
    const raw =
      answers[openCodeQuestionId(index, question)] ??
      answers[question.header] ??
      answers[question.question];
    if (Array.isArray(raw)) {
      return raw.filter((value): value is string => typeof value === "string");
    }
    if (typeof raw === "string") {
      return raw.trim().length > 0 ? [raw] : [];
    }
    return [];
  });
}

function ensureRuntimeError(
  operation: OpenCodeRuntimeError["operation"],
  detail: string,
  cause: unknown,
): OpenCodeRuntimeError {
  return OpenCodeRuntimeError.is(cause)
    ? cause
    : new OpenCodeRuntimeError({ operation, detail, cause });
}

const makeOpenCodeRuntime = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const netService = yield* NetService;

  const runOpenCodeCommand: OpenCodeRuntimeShape["runOpenCodeCommand"] = (input) =>
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(input.binaryPath, [...input.args], {
          shell: process.platform === "win32",
          env: input.environment ?? process.env,
        }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [collectStreamAsString(child.stdout), collectStreamAsString(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      const exitCode = Number(code);
      if (isWindowsCommandNotFound(exitCode, stderr)) {
        return yield* new OpenCodeRuntimeError({
          operation: "runOpenCodeCommand",
          detail: `spawn ${input.binaryPath} ENOENT`,
        });
      }
      return {
        stdout,
        stderr,
        code: exitCode,
      } satisfies OpenCodeCommandResult;
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        ensureRuntimeError(
          "runOpenCodeCommand",
          `Failed to execute '${input.binaryPath} ${input.args.join(" ")}': ${openCodeRuntimeErrorDetail(cause)}`,
          cause,
        ),
      ),
    );

  const startOpenCodeServerProcess: OpenCodeRuntimeShape["startOpenCodeServerProcess"] = (input) =>
    Effect.gen(function* () {
      // Version gate before anything else: never spawn `serve` on an OpenCode this build cannot
      // run. This is the single spawn site, so the owner, the probe and the adapter all inherit it.
      // A caller that just ran the same gate on this binary passes its result instead.
      if (
        input.verifiedBinaryVersion === undefined ||
        describeUnsupportedOpenCodeVersion(input.verifiedBinaryVersion, "binary") !== null
      ) {
        yield* assertSupportedOpenCodeBinary(runOpenCodeCommand, {
          binaryPath: input.binaryPath,
          ...(input.environment !== undefined ? { environment: input.environment } : {}),
        });
      }

      // Bind this server's lifetime to the caller's scope. When the caller's
      // scope closes, the spawned child is killed and all associated fibers
      // are interrupted automatically — no `close()` method needed.
      const runtimeScope = yield* Scope.Scope;

      const hostname = input.hostname ?? DEFAULT_HOSTNAME;
      const port =
        input.port ??
        (yield* netService.findAvailablePort(0).pipe(
          Effect.mapError(
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: `Failed to find available port: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        ));
      const timeoutMs = input.timeoutMs ?? DEFAULT_OPENCODE_SERVER_TIMEOUT_MS;
      const args = ["serve", `--hostname=${hostname}`, `--port=${port}`];
      const serverPassword = resolveOpenCodeServerPassword({
        external: false,
        ...(input.serverPassword !== undefined ? { configuredPassword: input.serverPassword } : {}),
        ...(input.environment !== undefined ? { environment: input.environment } : {}),
      });

      const child = yield* spawnAgentProcess(
        spawner,
        input.processPriority,
        ChildProcess.make(input.binaryPath, args, {
          detached: process.platform !== "win32",
          shell: process.platform === "win32",
          env: {
            ...(input.environment ?? process.env),
            ...(serverPassword !== undefined ? { OPENCODE_SERVER_PASSWORD: serverPassword } : {}),
            OPENCODE_CONFIG_CONTENT: JSON.stringify({}),
          },
        }),
      ).pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.mapError(
          (cause) =>
            new OpenCodeRuntimeError({
              operation: "startOpenCodeServerProcess",
              detail: `Failed to spawn OpenCode server process: ${openCodeRuntimeErrorDetail(cause)}`,
              cause,
            }),
        ),
      );

      // The direct child may already have exited after starting the server, so
      // the whole process group is terminated: the spawner's kill signals the
      // group (taskkill /T on Windows), polls until the leader and the group are
      // gone and SIGKILLs only what outlives the grace. Teardown therefore costs
      // the group's real exit time, not a fixed second: every OpenCode server
      // shutdown sits on the server's exit path.
      yield* Scope.addFinalizer(
        runtimeScope,
        Effect.ignore(
          child.kill({ killSignal: "SIGTERM", forceKillAfter: OPENCODE_SERVER_TERMINATE_GRACE }),
        ),
      );

      const stdoutRef = yield* Ref.make("");
      const stderrRef = yield* Ref.make("");
      const readyDeferred = yield* Deferred.make<string, OpenCodeRuntimeError>();

      const setReadyFromStdoutChunk = (chunk: string) =>
        Ref.updateAndGet(stdoutRef, (stdout) => `${stdout}${chunk}`).pipe(
          Effect.flatMap((nextStdout) => {
            const parsed = parseServerUrlFromOutput(nextStdout);
            return parsed
              ? Deferred.succeed(readyDeferred, parsed).pipe(Effect.ignore)
              : Effect.void;
          }),
        );

      const stdoutFiber = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach(setReadyFromStdoutChunk),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );
      const stderrFiber = yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) => Ref.update(stderrRef, (stderr) => `${stderr}${chunk}`)),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      const exitFiber = yield* child.exitCode.pipe(
        Effect.flatMap((code) =>
          Effect.gen(function* () {
            const stdout = yield* Ref.get(stdoutRef);
            const stderr = yield* Ref.get(stderrRef);
            const exitCode = Number(code);
            yield* Deferred.fail(
              readyDeferred,
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: [
                  `OpenCode server exited before startup completed (code: ${String(exitCode)}).`,
                  stdout.trim() ? `stdout:\n${stdout.trim()}` : null,
                  stderr.trim() ? `stderr:\n${stderr.trim()}` : null,
                ]
                  .filter(Boolean)
                  .join("\n\n"),
                cause: { exitCode, stdout, stderr },
              }),
            ).pipe(Effect.ignore);
          }),
        ),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      const readyExit = yield* Effect.exit(
        Deferred.await(readyDeferred).pipe(timeoutWhileResponsiveOption(timeoutMs)),
      );

      // Startup-time fibers are no longer needed once ready has resolved (either
      // way). The exit fiber is only interrupted on failure; on success it keeps
      // the caller's `exitCode` effect observable until the scope closes.
      yield* Fiber.interrupt(stdoutFiber).pipe(Effect.ignore);
      yield* Fiber.interrupt(stderrFiber).pipe(Effect.ignore);

      if (Exit.isFailure(readyExit)) {
        yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
        const squashed = Cause.squash(readyExit.cause);
        return yield* ensureRuntimeError(
          "startOpenCodeServerProcess",
          `Failed while waiting for OpenCode server startup: ${openCodeRuntimeErrorDetail(squashed)}`,
          squashed,
        );
      }

      const readyOption = readyExit.value;
      if (Option.isNone(readyOption)) {
        yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
        return yield* new OpenCodeRuntimeError({
          operation: "startOpenCodeServerProcess",
          detail: `Timed out waiting for OpenCode server start after ${timeoutMs}ms.`,
        });
      }

      return {
        url: readyOption.value,
        ...(serverPassword !== undefined ? { serverPassword } : {}),
        exitCode: child.exitCode.pipe(
          Effect.map(Number),
          Effect.orElseSucceed(() => 0),
        ),
      } satisfies OpenCodeServerProcess;
    });

  const connectToOpenCodeServer: OpenCodeRuntimeShape["connectToOpenCodeServer"] = (input) => {
    const serverUrl = input.serverUrl?.trim();
    if (serverUrl) {
      const serverPassword = resolveOpenCodeServerPassword({
        external: true,
        ...(input.serverPassword !== undefined ? { configuredPassword: input.serverPassword } : {}),
      });
      // We don't own externally-configured servers — no scope interaction.
      return Effect.succeed({
        url: serverUrl,
        ...(serverPassword !== undefined ? { serverPassword } : {}),
        exitCode: null,
        external: true,
      });
    }

    return startOpenCodeServerProcess({
      binaryPath: input.binaryPath,
      ...(input.verifiedBinaryVersion !== undefined
        ? { verifiedBinaryVersion: input.verifiedBinaryVersion }
        : {}),
      ...(input.serverPassword !== undefined ? { serverPassword: input.serverPassword } : {}),
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.processPriority !== undefined ? { processPriority: input.processPriority } : {}),
    }).pipe(
      Effect.map((server) => ({
        url: server.url,
        ...(server.serverPassword !== undefined ? { serverPassword: server.serverPassword } : {}),
        exitCode: server.exitCode,
        external: false,
      })),
    );
  };

  const createOpenCodeSdkClient: OpenCodeRuntimeShape["createOpenCodeSdkClient"] = (input) =>
    Effect.flatMap(loadOpenCodeProtocol, (protocol) => protocol.createOpenCodeApi(input));

  const loadProviders = (client: OpenCodeApi) =>
    runOpenCodeSdk("provider.list", (signal) => client.provider.list({}, { signal })).pipe(
      Effect.filterMapOrFail(
        (list) =>
          list.data
            ? Result.succeed(list.data)
            : Result.fail(
                new OpenCodeRuntimeError({
                  operation: "provider.list",
                  detail: "OpenCode provider list was empty.",
                }),
              ),
        (result) => result,
      ),
    );

  const loadAgents = (client: OpenCodeApi) =>
    runOpenCodeSdk("app.agents", (signal) => client.app.agents({}, { signal })).pipe(
      Effect.map((result) => result.data ?? []),
    );

  const loadOpenCodeInventory: OpenCodeRuntimeShape["loadOpenCodeInventory"] = (client) =>
    Effect.all([loadProviders(client), loadAgents(client)], { concurrency: "unbounded" }).pipe(
      Effect.map(([providerList, agents]) => ({ providerList, agents })),
    );

  return {
    startOpenCodeServerProcess,
    connectToOpenCodeServer,
    runOpenCodeCommand,
    createOpenCodeSdkClient,
    loadOpenCodeInventory,
  } satisfies OpenCodeRuntimeShape;
});

export class OpenCodeRuntime extends Context.Service<OpenCodeRuntime, OpenCodeRuntimeShape>()(
  "ryco/provider/OpenCodeRuntime",
) {}

export const OpenCodeRuntimeLive = Layer.effect(OpenCodeRuntime, makeOpenCodeRuntime).pipe(
  Layer.provide(NetService.layer),
);
