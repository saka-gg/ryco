import type { ServerProvider } from "@ryco/contracts";

// What the user updates, which is the CLI and not the provider's brand.
const RUNTIME_LABELS: ReadonlyMap<string, string> = new Map([
  ["claudeAgent", "Claude Code"],
  ["codex", "the Codex CLI"],
]);

const MAX_NAMED_MODELS = 3;

function joinModelNames(names: ReadonlyArray<string>): string {
  if (names.length <= 2) return names.join(" and ");
  if (names.length > MAX_NAMED_MODELS) {
    const named = names.slice(0, MAX_NAMED_MODELS).join(", ");
    return `${named}, and ${names.length - MAX_NAMED_MODELS} more`;
  }
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

/**
 * The model picker's notice for current models this instance's CLI is too old
 * to run, limited to the ones a search query matches by name or slug. `null`
 * when none match. The server sorts `updateRequiredModels` by `minVersion`
 * ascending, so the last match carries the version that unlocks every match.
 */
export function formatProviderUpdateRequiredNotice(
  provider: Pick<ServerProvider, "driver" | "displayName" | "updateRequiredModels">,
  searchQuery = "",
): string | null {
  const query = searchQuery.trim().toLowerCase();
  const matches = (provider.updateRequiredModels ?? []).filter(
    (model) =>
      query.length === 0 ||
      model.name.toLowerCase().includes(query) ||
      model.slug.toLowerCase().includes(query),
  );
  const highest = matches.at(-1);
  if (!highest) return null;
  const runtime = RUNTIME_LABELS.get(provider.driver) ?? provider.displayName ?? provider.driver;
  const version = highest.minVersion.startsWith("v")
    ? highest.minVersion
    : `v${highest.minVersion}`;
  const names = joinModelNames(matches.map((model) => model.name));
  return `Update ${runtime} to ${version} or newer to use ${names}.`;
}
