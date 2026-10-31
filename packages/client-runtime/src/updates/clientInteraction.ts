/**
 * Tells nodes that update themselves unattended when a person uses this client.
 *
 * A node with `automaticUpdates` on installs provider CLI updates only after nobody has used any
 * of its clients for a while (`server.noteClientInteraction`). Web (capture-phase input listeners,
 * installed only while a connected node wants reports) and mobile (touches while the app is in
 * front) feed their input to one reporter from here; it decides which nodes hear about it and how
 * often. A node that does not want reports never gets one, and older nodes never want them.
 *
 * @module clientInteraction
 */
import type { EnvironmentId, ServerConfig } from "@ryco/contracts";

/** At most one report per node this often while there is input. */
export const CLIENT_INTERACTION_REPORT_INTERVAL_MS = 30_000;
/** Input closer together than this is one burst: the connections are not even looked at. */
const BURST_MS = 1_000;

/** Whether a node wants to hear about input: it updates its provider CLIs unattended. */
export function nodeWantsClientInteraction(config: ServerConfig | null | undefined): boolean {
  const settings = config?.settings;
  return settings?.automaticUpdates === true && settings.enableProviderUpdateChecks;
}

export interface ClientInteractionConnection {
  readonly environmentId: EnvironmentId;
  readonly client: {
    readonly server: { readonly noteClientInteraction: () => Promise<unknown> };
  };
}

export interface ClientInteractionReporterSources {
  /** The connections this client holds now. */
  readonly listConnections: () => ReadonlyArray<ClientInteractionConnection>;
  /** A node's last known config; null while unknown. */
  readonly readServerConfig: (environmentId: EnvironmentId) => ServerConfig | null;
  /** Milliseconds on a clock that never jumps (`performance.now`). */
  readonly now: () => number;
}

export interface ClientInteractionReporter {
  /** A person used this client just now. Cheap enough for every input event. */
  readonly noteInteraction: () => void;
  /** Whether any connected node wants reports, so input listeners are worth having. */
  readonly wanted: () => boolean;
}

export function createClientInteractionReporter(
  sources: ClientInteractionReporterSources,
): ClientInteractionReporter {
  const sentAt = new Map<EnvironmentId, number>();
  let lastLookAt: number | null = null;
  const wants = (environmentId: EnvironmentId) =>
    nodeWantsClientInteraction(sources.readServerConfig(environmentId));

  return {
    noteInteraction: () => {
      const now = sources.now();
      if (lastLookAt !== null && now - lastLookAt < BURST_MS) return;
      lastLookAt = now;
      for (const { environmentId, client } of sources.listConnections()) {
        const last = sentAt.get(environmentId);
        if (last !== undefined && now - last < CLIENT_INTERACTION_REPORT_INTERVAL_MS) continue;
        if (!wants(environmentId)) continue;
        sentAt.set(environmentId, now);
        // A lost report only lets an update start sooner; the next input sends another.
        void Promise.resolve()
          .then(() => client.server.noteClientInteraction())
          .catch(() => undefined);
      }
    },
    wanted: () => sources.listConnections().some(({ environmentId }) => wants(environmentId)),
  };
}
