import { NonNegativeInt } from "@ryco/contracts";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadProposedPlansInput,
  GetProjectionThreadActionablePlanInput,
  ListProjectionThreadProposedPlansInput,
  ProjectionThreadProposedPlan,
  ProjectionThreadProposedPlanRepository,
  type ProjectionThreadProposedPlanRepositoryShape,
} from "../Services/ProjectionThreadProposedPlans.ts";

const makeProjectionThreadProposedPlanRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadProposedPlanRow = SqlSchema.void({
    Request: ProjectionThreadProposedPlan,
    execute: (row) => sql`
      INSERT INTO projection_thread_proposed_plans (
        plan_id,
        thread_id,
        turn_id,
        plan_markdown,
        implemented_at,
        implementation_thread_id,
        created_at,
        updated_at
      )
      VALUES (
        ${row.planId},
        ${row.threadId},
        ${row.turnId},
        ${row.planMarkdown},
        ${row.implementedAt},
        ${row.implementationThreadId},
        ${row.createdAt},
        ${row.updatedAt}
      )
      ON CONFLICT (plan_id)
      DO UPDATE SET
        thread_id = excluded.thread_id,
        turn_id = excluded.turn_id,
        plan_markdown = excluded.plan_markdown,
        implemented_at = excluded.implemented_at,
        implementation_thread_id = excluded.implementation_thread_id,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  const listProjectionThreadProposedPlanRows = SqlSchema.findAll({
    Request: ListProjectionThreadProposedPlansInput,
    Result: ProjectionThreadProposedPlan,
    execute: ({ threadId }) => sql`
      SELECT
        plan_id AS "planId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        plan_markdown AS "planMarkdown",
        implemented_at AS "implementedAt",
        implementation_thread_id AS "implementationThreadId",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_proposed_plans
      WHERE thread_id = ${threadId}
      ORDER BY created_at ASC, plan_id ASC
    `,
  });

  const deleteProjectionThreadProposedPlanRows = SqlSchema.void({
    Request: DeleteProjectionThreadProposedPlansInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_proposed_plans
      WHERE thread_id = ${threadId}
    `,
  });

  const getActionablePlanState = SqlSchema.findOne({
    Request: GetProjectionThreadActionablePlanInput,
    Result: Schema.Struct({ hasActionableProposedPlan: NonNegativeInt }),
    execute: ({ threadId, latestTurnId }) => sql`
      SELECT CASE
        WHEN ${latestTurnId} IS NOT NULL AND EXISTS (
          SELECT 1
          FROM projection_thread_proposed_plans
          WHERE thread_id = ${threadId}
            AND turn_id = ${latestTurnId}
        ) THEN CASE WHEN (
          SELECT implemented_at
          FROM projection_thread_proposed_plans
          WHERE thread_id = ${threadId}
            AND turn_id = ${latestTurnId}
          ORDER BY updated_at DESC, plan_id DESC
          LIMIT 1
        ) IS NULL THEN 1 ELSE 0 END
        WHEN EXISTS (
          SELECT 1
          FROM projection_thread_proposed_plans
          WHERE thread_id = ${threadId}
        ) THEN CASE WHEN (
          SELECT implemented_at
          FROM projection_thread_proposed_plans
          WHERE thread_id = ${threadId}
          ORDER BY updated_at DESC, plan_id DESC
          LIMIT 1
        ) IS NULL THEN 1 ELSE 0 END
        ELSE 0
      END AS "hasActionableProposedPlan"
    `,
  });

  const upsert: ProjectionThreadProposedPlanRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadProposedPlanRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadProposedPlanRepository.upsert:query")),
    );

  const listByThreadId: ProjectionThreadProposedPlanRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadProposedPlanRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadProposedPlanRepository.listByThreadId:query"),
      ),
    );

  const hasActionableForThread: ProjectionThreadProposedPlanRepositoryShape["hasActionableForThread"] =
    (input) =>
      getActionablePlanState(input).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "ProjectionThreadProposedPlanRepository.hasActionableForThread:query",
          ),
        ),
        Effect.map((row) => row.hasActionableProposedPlan === 1),
      );

  const deleteByThreadId: ProjectionThreadProposedPlanRepositoryShape["deleteByThreadId"] = (
    input,
  ) =>
    deleteProjectionThreadProposedPlanRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadProposedPlanRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    listByThreadId,
    hasActionableForThread,
    deleteByThreadId,
  } satisfies ProjectionThreadProposedPlanRepositoryShape;
});

export const ProjectionThreadProposedPlanRepositoryLive = Layer.effect(
  ProjectionThreadProposedPlanRepository,
  makeProjectionThreadProposedPlanRepository,
);
