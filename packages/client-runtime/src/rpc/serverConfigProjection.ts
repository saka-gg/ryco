import type {
  ServerConfig,
  ServerConfigProviderStatusesDeltaPayload,
  ServerConfigStreamEvent,
  ServerProvider,
} from "@ryco/contracts";

/**
 * Project one server-config stream event onto an environment-local snapshot.
 * Incremental events are intentionally ignored until that stream has supplied
 * an authoritative snapshot for its current connection generation.
 */
export function projectServerConfigEvent(
  current: ServerConfig | null,
  event: ServerConfigStreamEvent,
): ServerConfig | null {
  switch (event.type) {
    case "snapshot":
      return event.config;
    case "keybindingsUpdated":
      return current
        ? {
            ...current,
            keybindings: event.payload.keybindings,
            issues: event.payload.issues,
          }
        : null;
    case "providerStatuses":
      return current ? { ...current, providers: event.payload.providers } : null;
    case "providerStatusesDelta": {
      if (!current) return null;
      const providers = applyProviderStatusesDelta(current.providers, event.payload);
      return providers === null ? null : { ...current, providers };
    }
    case "settingsUpdated":
      return current ? { ...current, settings: event.payload.settings } : null;
  }
}

/**
 * The provider list after a `providerStatusesDelta`. An unchanged instance
 * keeps its object, and a changed one keeps each catalog the delta left out.
 * `null` when the delta does not fit the list it was made against (an
 * instance it names neither carries nor was sent before), which a client
 * treats like any other unusable event: it waits for the next snapshot.
 */
export function applyProviderStatusesDelta(
  current: ReadonlyArray<ServerProvider>,
  delta: ServerConfigProviderStatusesDeltaPayload,
): ServerProvider[] | null {
  const previousById = new Map(current.map((provider) => [provider.instanceId, provider] as const));
  const updatesById = new Map(
    delta.providers.map((update) => [update.instanceId, update] as const),
  );
  const next: ServerProvider[] = [];
  for (const instanceId of delta.instanceIds) {
    const previous = previousById.get(instanceId);
    const update = updatesById.get(instanceId);
    if (update === undefined) {
      if (previous === undefined) return null;
      next.push(previous);
      continue;
    }
    const models = update.models ?? previous?.models;
    const skills = update.skills ?? previous?.skills;
    const slashCommands = update.slashCommands ?? previous?.slashCommands;
    if (models === undefined || skills === undefined || slashCommands === undefined) return null;
    next.push({ ...update, models, skills, slashCommands });
  }
  return next;
}
