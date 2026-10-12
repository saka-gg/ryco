import {
  OrchestrationGetTurnDiffResult,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetTurnDiffResult as OrchestrationGetTurnDiffResultType,
} from "@ryco/contracts";
import { LRUCache } from "@ryco/shared/lruCache";
import { Effect, Layer, Option, Schema } from "effect";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { CheckpointInvariantError, CheckpointUnavailableError } from "../Errors.ts";
import { checkpointRefForThreadTurn } from "../Utils.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import {
  CheckpointDiffQuery,
  type CheckpointDiffQueryShape,
} from "../Services/CheckpointDiffQuery.ts";

const isTurnDiffResult = Schema.is(OrchestrationGetTurnDiffResult);

/**
 * Patches keyed by resolved commit OIDs. Checkpoint commits are content
 * addressed, so an entry's content can never go stale: a ref rewritten by a
 * revert resolves to a different OID and misses. Serves second clients and the
 * refetch after a provider invalidation without re-running `git diff`.
 *
 * Accepted trade-off: the patch's presentation also depends on working-tree
 * `.gitattributes` (any directory) and diff config, which the key leaves out;
 * keying on them would mean walking the tree per request. An edit to those
 * shows under the old presentation until the entry is evicted (32 entries).
 */
const CHECKPOINT_DIFF_CACHE_MAX_ENTRIES = 32;
const CHECKPOINT_DIFF_CACHE_MAX_BYTES = 32 * 1024 * 1024;

const checkpointDiffCacheKey = (input: {
  readonly cwd: string;
  readonly fromCommitOid: string;
  readonly toCommitOid: string;
  readonly ignoreWhitespace: boolean;
}) => JSON.stringify([input.cwd, input.fromCommitOid, input.toCommitOid, input.ignoreWhitespace]);

const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const checkpointStore = yield* CheckpointStore;
  const diffCache = new LRUCache<string>(
    CHECKPOINT_DIFF_CACHE_MAX_ENTRIES,
    CHECKPOINT_DIFF_CACHE_MAX_BYTES,
  );

  const getTurnDiff: CheckpointDiffQueryShape["getTurnDiff"] = Effect.fn("getTurnDiff")(
    function* (input) {
      const operation = "CheckpointDiffQuery.getTurnDiff";
      const ignoreWhitespace = input.ignoreWhitespace ?? true;

      if (input.fromTurnCount === input.toTurnCount) {
        const emptyDiff: OrchestrationGetTurnDiffResultType = {
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          diff: "",
        };
        if (!isTurnDiffResult(emptyDiff)) {
          return yield* new CheckpointInvariantError({
            operation,
            detail: "Computed turn diff result does not satisfy contract schema.",
          });
        }
        return emptyDiff;
      }

      const threadContext = yield* projectionSnapshotQuery.getThreadCheckpointContext(
        input.threadId,
      );
      if (Option.isNone(threadContext)) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: `Thread '${input.threadId}' not found.`,
        });
      }

      const maxTurnCount = threadContext.value.checkpoints.reduce(
        (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
        0,
      );
      if (input.toTurnCount > maxTurnCount) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          detail: `Turn diff range exceeds current turn count: requested ${input.toTurnCount}, current ${maxTurnCount}.`,
        });
      }

      const workspaceCwd = threadContext.value.worktreePath ?? threadContext.value.workspaceRoot;
      if (!workspaceCwd) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: `Workspace path missing for thread '${input.threadId}' when computing turn diff.`,
        });
      }

      const fromCheckpointRef =
        input.fromTurnCount === 0
          ? checkpointRefForThreadTurn(input.threadId, 0)
          : threadContext.value.checkpoints.find(
              (checkpoint) => checkpoint.checkpointTurnCount === input.fromTurnCount,
            )?.checkpointRef;
      if (!fromCheckpointRef) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.fromTurnCount,
          detail: `Checkpoint ref is unavailable for turn ${input.fromTurnCount}.`,
        });
      }

      const toCheckpointRef = threadContext.value.checkpoints.find(
        (checkpoint) => checkpoint.checkpointTurnCount === input.toTurnCount,
      )?.checkpointRef;
      if (!toCheckpointRef) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          detail: `Checkpoint ref is unavailable for turn ${input.toTurnCount}.`,
        });
      }

      // One Git process answers both refs; the OIDs then feed the diff directly.
      const [fromCommitOid, toCommitOid] = yield* checkpointStore.resolveCheckpointCommits({
        cwd: workspaceCwd,
        checkpointRefs: [fromCheckpointRef, toCheckpointRef],
      });

      if (!fromCommitOid) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.fromTurnCount,
          detail: `Filesystem checkpoint is unavailable for turn ${input.fromTurnCount}.`,
        });
      }

      if (!toCommitOid) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          detail: `Filesystem checkpoint is unavailable for turn ${input.toTurnCount}.`,
        });
      }

      const diffInput = {
        cwd: workspaceCwd,
        fromCommitOid,
        toCommitOid,
        ignoreWhitespace,
      };
      const cacheKey = checkpointDiffCacheKey(diffInput);
      let diff = diffCache.get(cacheKey);
      if (diff === null) {
        const computed = yield* checkpointStore.diffCheckpointCommits(diffInput);
        // UTF-16 length approximates retained bytes closely enough for a bound.
        diffCache.set(cacheKey, computed, computed.length * 2);
        diff = computed;
      }

      const turnDiff: OrchestrationGetTurnDiffResultType = {
        threadId: input.threadId,
        fromTurnCount: input.fromTurnCount,
        toTurnCount: input.toTurnCount,
        diff,
      };
      if (!isTurnDiffResult(turnDiff)) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: "Computed turn diff result does not satisfy contract schema.",
        });
      }

      return turnDiff;
    },
  );

  const getFullThreadDiff: CheckpointDiffQueryShape["getFullThreadDiff"] = (
    input: OrchestrationGetFullThreadDiffInput,
  ) =>
    getTurnDiff({
      threadId: input.threadId,
      fromTurnCount: 0,
      toTurnCount: input.toTurnCount,
      ignoreWhitespace: input.ignoreWhitespace ?? true,
    }).pipe(Effect.map((result): OrchestrationGetFullThreadDiffResult => result));

  return {
    getTurnDiff,
    getFullThreadDiff,
  } satisfies CheckpointDiffQueryShape;
});

export const CheckpointDiffQueryLive = Layer.effect(CheckpointDiffQuery, make);
