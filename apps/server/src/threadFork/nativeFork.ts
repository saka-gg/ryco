/**
 * Provider-native fork primitives: an independent copy of a source thread's provider session
 * that ends exactly at a selected completed turn, for the fork thread to resume.
 *
 * Each call either proves the copy (`forked`), proves that no exact copy is possible without
 * creating anything (`turn-not-in-session`, `refused`), or fails with `NativeForkUncertain` when
 * the provider may have created a copy Ryco cannot prove. Callers must never repeat a fork whose
 * outcome is uncertain, and never use or delete such a copy.
 *
 * Every provider call runs out of process against the instance's own store (a short-lived
 * `codex app-server`, an isolated Claude SDK process), never through a live session.
 */
import { realpath, stat } from "node:fs/promises";

import type { ProviderInstanceConfig, ThreadId, TurnId } from "@ryco/contracts";
import { Data, Effect, FileSystem, Path, Schema } from "effect";
import { CodexAppServerRequestError } from "effect-codex-app-server/errors";
import type { V2ThreadReadResponse } from "effect-codex-app-server/schema";
import { ChildProcessSpawner } from "effect/process";

import {
  forkClaudeNativeCopy,
  readClaudeMainChain,
  removeClaudeSessionCopy,
} from "../imports/claudeNativeFork.ts";
import {
  type CodexHomeLayout,
  materializeCodexShadowHome,
} from "../provider/Drivers/CodexHomeLayout.ts";
import { claudeTurnCutoff, isClaudeCutoffInChain } from "../provider/claudeTranscriptCutoff.ts";
import { withIsolatedCodexAppServer } from "../provider/codexIsolatedAppServer.ts";
import { resolveProviderSourceLayout } from "../provider/ProviderSourceLayout.ts";
import { canonicalJson, sha256Hex } from "../canonicalJson.ts";
import {
  type ThreadForkClaudeCutoff,
  type ThreadForkNativeDriver,
  ThreadForkOwnedNativeCopy,
} from "./forkLedger.ts";

export type NativeForkOutcome =
  | {
      readonly kind: "forked";
      /** Codex thread id, or Claude session uuid, of the verified copy. */
      readonly nativeThreadId: string;
      /** Proof of ownership: the only native data a failed fork may delete. */
      readonly ownedCopy: ThreadForkOwnedNativeCopy;
    }
  /** The selected turn is not provably in the source's native session. Nothing was created. */
  | { readonly kind: "turn-not-in-session" }
  /** No copy exists: the provider refused, or a copy failed verification and was removed. */
  | { readonly kind: "refused"; readonly detail: string };

/** The provider may have created a copy Ryco cannot prove. Never repeat the fork. */
export class NativeForkUncertain extends Schema.TaggedError<NativeForkUncertain>()(
  "NativeForkUncertain",
  {
    detail: Schema.String,
    /** Set when the copy's id is known but it could neither be verified nor removed. */
    nativeThreadId: Schema.optional(Schema.String),
    /** With `nativeThreadId`: where that copy is, so the caller can record it and retry removal. */
    ownedCopy: Schema.optional(ThreadForkOwnedNativeCopy),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class NativeForkCleanupError extends Schema.TaggedError<NativeForkCleanupError>()(
  "NativeForkCleanupError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const errorDetail = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback;

const refused = (detail: string): NativeForkOutcome => ({ kind: "refused", detail });

/** A read-only provider step failed: nothing was created. */
class NativeReadFailed extends Data.TaggedError("NativeReadFailed")<{
  readonly detail: string;
}> {}

const readFailed = (fallback: string) => (cause: unknown) =>
  new NativeReadFailed({ detail: errorDetail(cause, fallback) });

/** Native session ids derive the target's provider store from the cwd string: it must be real. */
const assertCanonicalDirectory = (cwd: string) =>
  Effect.promise(async () => {
    try {
      return (await realpath(cwd)) === cwd && (await stat(cwd)).isDirectory();
    } catch {
      return false;
    }
  });

// ---------------------------------------------------------------------------------------------
// Provider store

export class NativeForkStoreUnavailable extends Schema.TaggedError<NativeForkStoreUnavailable>()(
  "NativeForkStoreUnavailable",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Where an instance keeps its native sessions, resolved exactly like session import. */
export interface NativeForkStore {
  /** Canonical store root: `CODEX_HOME`'s shared home, or Claude's config directory. */
  readonly root: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly binaryPath: string;
  /** Codex only. */
  readonly codex: CodexHomeLayout | undefined;
}

export const resolveNativeForkStore = (
  driver: ThreadForkNativeDriver,
  config: ProviderInstanceConfig,
): Effect.Effect<NativeForkStore, NativeForkStoreUnavailable, Path.Path> =>
  Effect.gen(function* () {
    const layout = yield* resolveProviderSourceLayout(driver, config).pipe(
      Effect.mapError(
        (cause) =>
          new NativeForkStoreUnavailable({
            detail: "The provider configuration is invalid.",
            cause,
          }),
      ),
    );
    const root = yield* Effect.tryPromise({
      try: () => realpath(layout.root),
      catch: (cause) =>
        new NativeForkStoreUnavailable({
          detail: "The provider's session store is unavailable.",
          cause,
        }),
    });
    return {
      root,
      environment: layout.environment,
      binaryPath: layout.binaryPath,
      codex: layout.codex,
    };
  });

/** Identifies an instance configuration; a fork accepted under another one hands off instead. */
export function nativeForkConfigFingerprint(config: ProviderInstanceConfig): string {
  return sha256Hex(canonicalJson(config));
}

// ---------------------------------------------------------------------------------------------
// Codex

type CodexThread = V2ThreadReadResponse["thread"];

export interface CodexNativeForkInput {
  readonly layout: CodexHomeLayout;
  readonly environment: NodeJS.ProcessEnv;
  readonly binaryPath: string;
  readonly sourceNativeThreadId: string;
  /** The boundary turn; Ryco turn ids are Codex turn ids. */
  readonly turnId: TurnId;
  /** The fork's effective cwd, canonical. */
  readonly cwd: string;
}

/**
 * JSON-RPC errors that prove `thread/fork` did not run: a parse error, or params rejected while
 * decoding. Codex also answers -32600/-32601 from store and metadata steps after the forked
 * rollout is persisted, so those (and anything else: a dead process, a timeout) leave the outcome
 * uncertain.
 */
const PRE_EXECUTION_ERROR_CODES = new Set([-32700, -32602]);

/** Why a returned Codex fork is not the exact copy that was asked for; null when it is. */
export function codexForkMismatch(input: {
  readonly fork: Pick<CodexThread, "id" | "forkedFromId" | "cwd" | "ephemeral" | "turns">;
  readonly forkId: string;
  readonly sourceNativeThreadId: string;
  readonly cwd: string;
  readonly expectedTurnIds: ReadonlyArray<string>;
}): string | null {
  const { fork } = input;
  if (fork.id !== input.forkId) return "Codex returned another thread for the fork.";
  if (fork.forkedFromId !== input.sourceNativeThreadId)
    return "The Codex copy does not record the source thread as its origin.";
  if (fork.cwd !== input.cwd) return "The Codex copy is not in the fork's folder.";
  if (fork.ephemeral) return "The Codex copy is not persisted.";
  const turnIds = fork.turns.map((turn) => turn.id);
  if (
    turnIds.length !== input.expectedTurnIds.length ||
    turnIds.some((turnId, index) => turnId !== input.expectedTurnIds[index])
  )
    return "The Codex copy does not end at the selected turn.";
  return null;
}

/**
 * Forks a Codex thread through `turnId` (`thread/fork` with `lastTurnId`) into `cwd`.
 *
 * Preflight: the source's stored turns must contain `turnId`, completed. After the fork, the
 * copy is read back and must name the source as its origin, live in `cwd`, be persisted, and
 * hold exactly the source's turns through `turnId`; otherwise it is deleted.
 */
export const forkCodexThroughTurn = (
  input: CodexNativeForkInput,
): Effect.Effect<
  NativeForkOutcome,
  NativeForkUncertain,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    if (!(yield* assertCanonicalDirectory(input.cwd))) {
      return refused("The fork's folder is not an existing canonical directory.");
    }
    const shadow = yield* Effect.result(materializeCodexShadowHome(input.layout));
    if (shadow._tag === "Failure") return refused(shadow.failure.detail);

    // How far the job got when it failed decides whether a copy may exist.
    const progress: {
      phase: "preflight" | "forking" | "verifying";
      forkId: string | undefined;
    } = { phase: "preflight", forkId: undefined };
    const run = withIsolatedCodexAppServer(input, (client) =>
      Effect.gen(function* () {
        const source = yield* client.request("thread/read", {
          threadId: input.sourceNativeThreadId,
          includeTurns: true,
        });
        const turns = source.thread.turns;
        const index = turns.findIndex((turn) => turn.id === input.turnId);
        if (index < 0 || turns[index]!.status !== "completed") {
          return { kind: "turn-not-in-session" } as const;
        }
        const expectedTurnIds = turns.slice(0, index + 1).map((turn) => turn.id);

        progress.phase = "forking";
        const fork = yield* client.request("thread/fork", {
          threadId: input.sourceNativeThreadId,
          lastTurnId: input.turnId,
          cwd: input.cwd,
          ephemeral: false,
        });
        const createdId = fork.thread.id;
        // Never treat the source itself as a copy: nothing may ever delete it.
        if (!createdId || createdId === input.sourceNativeThreadId) {
          return refused("Codex did not create a separate thread.");
        }
        progress.forkId = createdId;
        progress.phase = "verifying";
        const copy = yield* client.request("thread/read", {
          threadId: createdId,
          includeTurns: true,
        });
        const mismatch = codexForkMismatch({
          fork: copy.thread,
          forkId: createdId,
          sourceNativeThreadId: input.sourceNativeThreadId,
          cwd: input.cwd,
          expectedTurnIds,
        });
        if (mismatch !== null) {
          yield* client.request("thread/delete", { threadId: createdId });
          return refused(`${mismatch} The copy was removed.`);
        }
        return {
          kind: "forked",
          nativeThreadId: createdId,
          ownedCopy: { kind: "codex-thread", threadId: createdId },
        } as const satisfies NativeForkOutcome;
      }),
    );
    const result = yield* Effect.result(run);
    if (result._tag === "Success") return result.success;

    const failure = result.failure;
    const { phase, forkId: created } = progress;
    if (phase === "preflight") {
      return refused(errorDetail(failure, "Codex could not read the source thread."));
    }
    if (
      phase === "forking" &&
      Schema.is(CodexAppServerRequestError)(failure) &&
      PRE_EXECUTION_ERROR_CODES.has(failure.code)
    ) {
      return refused(failure.errorMessage);
    }
    if (created !== undefined) {
      // The copy exists and is ours, but could not be verified (or its removal failed).
      const removed = yield* Effect.result(removeCodexForkCopy({ ...input, threadId: created }));
      if (removed._tag === "Success") {
        return refused("Codex could not verify the fork. The copy was removed.");
      }
      return yield* new NativeForkUncertain({
        detail: "Codex created a fork that could not be verified or removed.",
        nativeThreadId: created,
        ownedCopy: { kind: "codex-thread", threadId: created },
        cause: failure,
      });
    }
    return yield* new NativeForkUncertain({
      detail: "Codex did not confirm the fork. A copy may exist; it was not used.",
      cause: failure,
    });
  });

/** Deletes a Codex thread this fork created and recorded (`thread/delete`). */
export const removeCodexForkCopy = (input: {
  readonly layout: CodexHomeLayout;
  readonly environment: NodeJS.ProcessEnv;
  readonly binaryPath: string;
  /** Any existing folder; the app-server's own cwd. */
  readonly cwd: string;
  readonly threadId: string;
}): Effect.Effect<void, NativeForkCleanupError, ChildProcessSpawner.ChildProcessSpawner> =>
  withIsolatedCodexAppServer(input, (client) =>
    client.request("thread/delete", { threadId: input.threadId }),
  ).pipe(
    Effect.asVoid,
    Effect.mapError(
      (cause) =>
        new NativeForkCleanupError({ detail: "Codex could not delete the fork copy.", cause }),
    ),
  );

/** The resume cursor a Codex fork thread's binding starts with (`CodexResumeCursorSchema`). */
export function codexForkResumeCursor(nativeThreadId: string): { readonly threadId: string } {
  return { threadId: nativeThreadId };
}

// ---------------------------------------------------------------------------------------------
// Claude

export interface ClaudeSourceSession {
  /** The instance's Claude config root (`CLAUDE_CONFIG_DIR`). */
  readonly root: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly sourceSessionId: string;
  /** The cwd the source session ran in: its transcript's project directory. */
  readonly recordedCwd: string;
  /** The boundary turn; Ryco turn ids are Claude prompt uuids. */
  readonly turnId: TurnId;
}

/** Where a Claude copy would end, read from the source transcript, or why it cannot be pinned. */
export type ClaudeCutoffPin =
  | {
      readonly kind: "pinned";
      readonly cutoff: ThreadForkClaudeCutoff;
      /**
       * No later turn bounds it: it is the transcript's tail at the read. The caller only keeps
       * such a pin when it proves nothing was appended after the boundary turn before the read.
       */
      readonly atTail: boolean;
    }
  /** The turn is not provably in the source's native session. */
  | { readonly kind: "turn-not-in-session" }
  | { readonly kind: "refused"; readonly detail: string };

const readSourceChain = (input: ClaudeSourceSession) =>
  Effect.tryPromise({
    try: () =>
      readClaudeMainChain({
        root: input.root,
        environment: input.environment,
        sessionId: input.sourceSessionId,
        cwd: input.recordedCwd,
      }),
    catch: readFailed("Claude could not read the source session."),
  }).pipe(Effect.result);

/**
 * Reads the source's main chain once and pins where the boundary turn ends (see
 * `claudeTurnCutoff`). Read-only; runs when the fork is accepted, so the copy later ends at this
 * entry however far the source has moved on by then.
 */
export const pinClaudeForkCutoff = (
  input: ClaudeSourceSession & {
    /** The source's turns after the boundary, oldest first. */
    readonly laterTurnIds: ReadonlyArray<TurnId>;
  },
): Effect.Effect<ClaudeCutoffPin> =>
  Effect.gen(function* () {
    const source = yield* readSourceChain(input);
    if (source._tag === "Failure") return { kind: "refused", detail: source.failure.detail };
    const chain = source.success;
    if (!chain.found) return { kind: "turn-not-in-session" };
    if (!chain.sameSession) {
      return {
        kind: "refused",
        detail: "The source transcript holds messages of another session.",
      };
    }
    const cutoff = claudeTurnCutoff({
      chainUuids: chain.chain.map((entry) => entry.uuid),
      turnPromptUuid: input.turnId,
      laterTurnIds: input.laterTurnIds,
    });
    if (cutoff === null) return { kind: "turn-not-in-session" };
    return {
      kind: "pinned",
      cutoff: { entryUuid: cutoff.uuid, entryIndex: cutoff.index },
      atTail: cutoff.atTail,
    };
  });

export interface ClaudeNativeForkInput extends ClaudeSourceSession {
  /** The fork's effective cwd, canonical; the copy is moved to its project directory. */
  readonly targetCwd: string;
  /** Pinned at acceptance (`pinClaudeForkCutoff`): the copy ends exactly here. */
  readonly cutoff: ThreadForkClaudeCutoff;
  /** The copy's session title; identifies Ryco's copy in Claude's own session list. */
  readonly title: string;
}

/** The title of a fork's Claude session copy. */
export function claudeForkSessionTitle(forkThreadId: ThreadId | string): string {
  return `Ryco fork ${forkThreadId}`;
}

/**
 * Removes every path a copy this fork created has. Removed: `refused(detail)`, so the caller
 * hands off. Not removed: `NativeForkUncertain` carrying the copy, so the caller records it.
 */
const removeOwnedClaudeCopy = (input: {
  readonly root: string;
  readonly sessionId: string;
  readonly files: ReadonlyArray<string>;
  readonly detail: string;
}) =>
  Effect.gen(function* () {
    for (const file of input.files) {
      const removed = yield* Effect.tryPromise(() =>
        removeClaudeSessionCopy({ root: input.root, sessionId: input.sessionId, file }),
      ).pipe(Effect.result);
      if (removed._tag === "Failure") {
        return yield* new NativeForkUncertain({
          detail: "Claude created a fork that could not be verified or removed.",
          nativeThreadId: input.sessionId,
          ownedCopy: { kind: "claude-file", root: input.root, file },
          cause: removed.failure,
        });
      }
    }
    return refused(`${input.detail} The copy was removed.`);
  });

/**
 * Forks a Claude session through the pinned end of `turnId` (`forkSession` with `upToMessageId` =
 * the pinned entry) into the target cwd's project directory.
 *
 * Preflight re-reads the source's main chain: the pinned entry must still be at its position with
 * the turn's prompt before it (a rewritten source hands off). After the fork, the copy's main
 * chain is read back from the target cwd and must repeat the source's entries through the
 * cutoff; otherwise it is deleted. A copy whose id is known is always removed or reported.
 */
export const forkClaudeThroughTurn = (
  input: ClaudeNativeForkInput,
): Effect.Effect<NativeForkOutcome, NativeForkUncertain> =>
  Effect.gen(function* () {
    if (!(yield* assertCanonicalDirectory(input.targetCwd))) {
      return refused("The fork's folder is not an existing canonical directory.");
    }
    const source = yield* readSourceChain(input);
    if (source._tag === "Failure") return refused(source.failure.detail);
    const sourceChain = source.success;
    if (!sourceChain.found) return { kind: "turn-not-in-session" } as const;
    if (!sourceChain.sameSession) {
      return refused("The source transcript holds messages of another session.");
    }
    const chain = sourceChain.chain;
    const { entryUuid, entryIndex } = input.cutoff;
    if (
      !isClaudeCutoffInChain({
        chainUuids: chain.map((entry) => entry.uuid),
        turnPromptUuid: input.turnId,
        cutoff: { uuid: entryUuid, index: entryIndex },
      })
    ) {
      return { kind: "turn-not-in-session" } as const;
    }
    const expectedTypes = chain.slice(0, entryIndex + 1).map((entry) => entry.type);

    const forked = yield* Effect.tryPromise({
      try: () =>
        forkClaudeNativeCopy({
          root: input.root,
          environment: input.environment,
          sourceFile: sourceChain.file,
          sourceId: input.sourceSessionId,
          sourceCwd: input.recordedCwd,
          lastMessageId: entryUuid,
          cwd: input.targetCwd,
          title: input.title,
        }),
      catch: (cause) =>
        new NativeForkUncertain({
          detail: "Claude did not confirm the fork. A copy may exist; it was not used.",
          cause,
        }),
    });
    switch (forked.kind) {
      case "not-created":
        return refused(forked.detail);
      case "created-unusable":
        return yield* removeOwnedClaudeCopy({
          root: input.root,
          sessionId: forked.sessionId,
          files: forked.files,
          detail: `Claude could not finish the fork (${forked.detail}).`,
        });
      case "created":
        break;
    }
    const copy = forked.copy;
    if (copy.sessionId === input.sourceSessionId) {
      return refused("Claude did not create a separate session.");
    }
    const removeCopy = (detail: string) =>
      removeOwnedClaudeCopy({
        root: input.root,
        sessionId: copy.sessionId,
        files: [copy.file],
        detail,
      });

    const verified = yield* Effect.tryPromise({
      try: () =>
        readClaudeMainChain({
          root: input.root,
          environment: input.environment,
          sessionId: copy.sessionId,
          cwd: input.targetCwd,
        }),
      catch: readFailed("Claude could not read the fork."),
    }).pipe(Effect.result);
    if (verified._tag === "Failure") {
      return yield* removeCopy("Claude could not verify the fork.");
    }
    const read = verified.success;
    if (
      !read.found ||
      read.file !== copy.file ||
      !read.sameSession ||
      read.chain.length !== expectedTypes.length ||
      read.chain.some((entry, index) => entry.type !== expectedTypes[index])
    ) {
      return yield* removeCopy("The Claude copy does not end at the selected turn.");
    }
    return {
      kind: "forked",
      nativeThreadId: copy.sessionId,
      ownedCopy: { kind: "claude-file", root: input.root, file: copy.file },
    } as const satisfies NativeForkOutcome;
  });

/** Deletes a Claude session copy this fork created and recorded. */
export const removeClaudeForkCopy = (input: {
  readonly root: string;
  readonly sessionId: string;
  readonly file: string;
}): Effect.Effect<void, NativeForkCleanupError> =>
  Effect.tryPromise({
    try: () => removeClaudeSessionCopy(input),
    catch: (cause) =>
      new NativeForkCleanupError({ detail: "The Claude fork copy could not be removed.", cause }),
  }).pipe(Effect.asVoid);

/**
 * The resume cursor a Claude fork thread's binding starts with (`ClaudeResumeState`): the copy,
 * resumed at its newest entry (the boundary), with no rewind.
 */
export function claudeForkResumeCursor(input: {
  readonly forkThreadId: ThreadId;
  readonly nativeSessionId: string;
  /** User turns the fork inherited; feeds checkpoint revert arithmetic. */
  readonly inheritedUserTurnCount: number;
}): { readonly threadId: ThreadId; readonly resume: string; readonly turnCount: number } {
  return {
    threadId: input.forkThreadId,
    resume: input.nativeSessionId,
    turnCount: input.inheritedUserTurnCount,
  };
}
