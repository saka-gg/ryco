import type { ServerProvider } from "@ryco/contracts";

const PROVIDER_STATUS_KEY_SEPARATOR = "\0";

function providerStatusesContentKey(providers: ReadonlyArray<ServerProvider>): string {
  const parts: string[] = [`${providers.length}`];
  for (const provider of providers) {
    parts.push(
      provider.instanceId,
      provider.driver,
      provider.displayName ?? "",
      provider.accentColor ?? "",
      provider.badgeLabel ?? "",
      provider.continuation?.groupKey ?? "",
      provider.showInteractionModeToggle ? "1" : "0",
      provider.supportsAskMode ? "1" : "0",
      provider.supportsTurnSteering ? "1" : "0",
      provider.enabled ? "1" : "0",
      provider.status,
      provider.installed ? "1" : "0",
      provider.availability ?? "",
      provider.unavailableReason ?? "",
      provider.auth.status,
      provider.auth.type ?? "",
      provider.auth.label ?? "",
      provider.auth.email ?? "",
      provider.message ?? "",
      // The composer's usage popup reads limits from these snapshots.
      provider.checkedAt,
      JSON.stringify(provider.rateLimits) ?? "",
    );
    for (const model of provider.models) {
      parts.push(
        "model",
        model.slug,
        model.name,
        model.shortName ?? "",
        model.subProvider ?? "",
        model.isCustom ? "1" : "0",
        JSON.stringify(model.capabilities) ?? "",
      );
    }
    for (const command of provider.slashCommands) {
      parts.push("command", command.name, command.description ?? "", command.input?.hint ?? "");
    }
    for (const skill of provider.skills) {
      parts.push(
        "skill",
        skill.name,
        skill.path,
        skill.enabled ? "1" : "0",
        skill.scope ?? "",
        skill.displayName ?? "",
        skill.shortDescription ?? "",
        skill.description ?? "",
      );
    }
  }
  return parts.join(PROVIDER_STATUS_KEY_SEPARATOR);
}

export function stabilizeProviderStatusesSnapshot(
  providers: ReadonlyArray<ServerProvider>,
  cache: { key: string; snapshot: ServerProvider[] },
): ServerProvider[] {
  const key = providerStatusesContentKey(providers);
  if (key === cache.key) {
    return cache.snapshot;
  }
  const snapshot = providers as ServerProvider[];
  cache.key = key;
  cache.snapshot = snapshot;
  return snapshot;
}
