/**
 * The command read model as the engine holds it right now.
 *
 * Startup repairs and restart continuations used to hydrate the SQL command read model again
 * (nine full-table reads, several times per boot) although the engine already holds the same
 * model in memory. Prefer the engine's copy; the SQL read model is only the fallback for test
 * doubles that do not expose it.
 *
 * @module currentCommandReadModel
 */
import type { OrchestrationReadModel } from "@ryco/contracts";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";

export const currentCommandReadModel = (
  engine: Pick<OrchestrationEngineShape, "getReadModel">,
  projections: Pick<ProjectionSnapshotQueryShape, "getCommandReadModel">,
): Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError> =>
  engine.getReadModel?.() ?? projections.getCommandReadModel();
