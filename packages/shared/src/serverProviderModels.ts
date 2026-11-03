/**
 * serverProviderModels — lookups over one provider snapshot's model list.
 *
 * The server gates a session on a snapshot model's flags and the clients show the same answer
 * in their pickers, so both find the model the same way.
 *
 * @module serverProviderModels
 */
import type { ServerProviderModel } from "@ryco/contracts";

/** The snapshot model a selection names, by slug or alias (case-insensitive). */
export function findServerProviderModel(
  models: ReadonlyArray<ServerProviderModel>,
  slugOrAlias: string | null | undefined,
): ServerProviderModel | undefined {
  const value = slugOrAlias?.trim().toLowerCase();
  if (!value) return undefined;
  return (
    models.find((model) => model.slug.toLowerCase() === value) ??
    models.find((model) => model.aliases?.some((alias) => alias.toLowerCase() === value))
  );
}
