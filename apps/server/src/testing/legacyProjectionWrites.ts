import { Effect, Layer, Option } from "effect";

import { applyThreadShellSummaryTransition } from "../orchestration/threadShellSummaryProjection.ts";
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThreadRepositoryShape,
} from "../persistence/Services/ProjectionThreads.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";

/**
 * What the threads projector did before `ProjectionThreadRepository.touch`: read the row, apply
 * the shell-summary transition, and upsert every column. Equivalence tests compare `touch` with it.
 */
export const legacyThreadTouch =
  (repository: ProjectionThreadRepositoryShape): ProjectionThreadRepositoryShape["touch"] =>
  (input) =>
    repository.getById({ threadId: input.threadId }).pipe(
      Effect.flatMap((row) =>
        Option.isNone(row)
          ? Effect.void
          : repository.upsert({
              ...row.value,
              ...applyThreadShellSummaryTransition(row.value, {
                pendingApprovalDelta: input.pendingApprovalDelta,
                pendingUserInputDelta: input.pendingUserInputDelta,
              }),
              updatedAt: input.updatedAt,
            }),
      ),
    );

/** The thread repository with `touch` replaced by the full-row write it narrows. */
export const LegacyTouchProjectionThreadRepositoryLive = Layer.effect(
  ProjectionThreadRepository,
  Effect.gen(function* () {
    const live = yield* ProjectionThreadRepository;
    return { ...live, touch: legacyThreadTouch(live) };
  }),
).pipe(Layer.provide(ProjectionThreadRepositoryLive));

/** The turn repository with `replaceByTurnId` upserting every row, changed or not. */
export const LegacyReplaceProjectionTurnRepositoryLive = Layer.effect(
  ProjectionTurnRepository,
  Effect.gen(function* () {
    const live = yield* ProjectionTurnRepository;
    return {
      ...live,
      replaceByTurnId: ({ next }: { readonly next: Parameters<typeof live.upsertByTurnId>[0] }) =>
        live.upsertByTurnId(next),
    };
  }),
).pipe(Layer.provide(ProjectionTurnRepositoryLive));
