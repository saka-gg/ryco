import {
  contextHandoffStatusSuffix,
  forkHandoffAccessibleLabel,
  forkHandoffEndpointLabels,
  isForkHandoff,
  resolvePendingComposerHandoff,
  resumeFallbackHandoffAccessibleLabel,
  resumeFallbackHandoffCopy,
  type ContextHandoffEndpointLabelers,
  type ContextHandoffMarkerSubject,
  type PendingComposerHandoff as SharedPendingComposerHandoff,
} from "@ryco/client-runtime/state/session";
import type {
  ContextHandoffEndpointSnapshot,
  ModelSelection,
  OrchestrationThreadActivity,
  ServerConfig,
} from "@ryco/contracts";
import { modelSelectionRequiresContextHandoff } from "@ryco/shared/model";

import { providerDisplayLabel } from "../../lib/providerDisplay";

export interface PendingContextHandoffPresentation {
  readonly source: ContextHandoffEndpointSnapshot;
  readonly target: ContextHandoffEndpointSnapshot;
  readonly accessibilityLabel: string;
}

export function contextHandoffProviderLabel(endpoint: ContextHandoffEndpointSnapshot): string {
  return (
    providerDisplayLabel(endpoint.driverKind, endpoint.providerDisplayName) ??
    endpoint.providerInstanceId
  );
}

export function contextHandoffModelLabel(endpoint: ContextHandoffEndpointSnapshot): string {
  return endpoint.modelDisplayName ?? endpoint.modelSlug;
}

export function contextHandoffEndpointAccessibleLabel(
  endpoint: ContextHandoffEndpointSnapshot,
): string {
  return `${contextHandoffProviderLabel(endpoint)} ${contextHandoffModelLabel(endpoint)}`;
}

function resolveEndpoint(
  selection: ModelSelection,
  config: ServerConfig | null | undefined,
): ContextHandoffEndpointSnapshot | null {
  const provider = config?.providers.find(
    (candidate) => candidate.instanceId === selection.instanceId,
  );
  if (!provider) return null;
  const model = provider.models.find((candidate) => candidate.slug === selection.model);

  return {
    providerInstanceId: provider.instanceId,
    driverKind: provider.driver,
    ...(provider.displayName ? { providerDisplayName: provider.displayName } : {}),
    ...(provider.accentColor ? { providerAccentColor: provider.accentColor } : {}),
    modelSlug: selection.model,
    ...(model ? { modelDisplayName: model.shortName ?? model.name } : {}),
  };
}

export function derivePendingContextHandoff(input: {
  readonly threadStarted: boolean;
  readonly canonicalSelection: ModelSelection | null | undefined;
  readonly targetSelection: ModelSelection;
  readonly serverConfig: ServerConfig | null | undefined;
}): PendingContextHandoffPresentation | null {
  if (!input.threadStarted || !input.canonicalSelection) return null;
  if (
    !modelSelectionRequiresContextHandoff({
      canonicalSelection: input.canonicalSelection,
      targetSelection: input.targetSelection,
    })
  ) {
    return null;
  }

  const source = resolveEndpoint(input.canonicalSelection, input.serverConfig);
  const target = resolveEndpoint(input.targetSelection, input.serverConfig);
  if (!source || !target) return null;

  return {
    source,
    target,
    accessibilityLabel: `Next message will hand off context from ${contextHandoffEndpointAccessibleLabel(source)} to ${contextHandoffEndpointAccessibleLabel(target)}`,
  };
}

/**
 * What the composer says about the next message's context handoff, by the shared precedence
 * (`resolvePendingComposerHandoff`): a fork's owed handoff, else a model change, else nothing.
 */
export type PendingComposerHandoff =
  SharedPendingComposerHandoff<PendingContextHandoffPresentation>;

export function derivePendingComposerHandoff(input: {
  readonly activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "kind" | "payload">>;
  readonly threadStarted: boolean;
  readonly canonicalSelection: ModelSelection | null | undefined;
  readonly targetSelection: ModelSelection | null | undefined;
  readonly serverConfig: ServerConfig | null | undefined;
}): PendingComposerHandoff | null {
  const { targetSelection } = input;
  return resolvePendingComposerHandoff({
    activities: input.activities,
    modelChange: () =>
      targetSelection
        ? derivePendingContextHandoff({
            threadStarted: input.threadStarted,
            canonicalSelection: input.canonicalSelection,
            targetSelection,
            serverConfig: input.serverConfig,
          })
        : null,
  });
}

/** Mobile's endpoint labels for the shared fork divider rule (`forkHandoffEndpointLabels`). */
export const CONTEXT_HANDOFF_ENDPOINT_LABELERS: ContextHandoffEndpointLabelers = {
  endpoint: contextHandoffEndpointAccessibleLabel,
  model: contextHandoffModelLabel,
};

/**
 * A model change reads as `<source> to <target>`. A resume fallback (a working-folder relocation,
 * or native history the provider no longer had) keeps its model, so it reads as a fresh session
 * instead, with the shared wording for its reason. A fork's handoff reads as the inherited conversation
 * reaching a fresh session of that model, naming the model it switched from when the first
 * message also changed provider. Handoffs recorded before they carried a reason are model
 * changes.
 */
export function contextHandoffMarkerAccessibilityLabel(
  input: ContextHandoffMarkerSubject & {
    readonly sources: ReadonlyArray<ContextHandoffEndpointSnapshot>;
    readonly target: ContextHandoffEndpointSnapshot;
    readonly changedFrom?: ContextHandoffEndpointSnapshot | undefined;
  },
): string {
  const resumeFallback = resumeFallbackHandoffCopy(input);
  if (resumeFallback) return resumeFallbackHandoffAccessibleLabel(resumeFallback, input);
  if (isForkHandoff(input)) {
    const labels = forkHandoffEndpointLabels(input, CONTEXT_HANDOFF_ENDPOINT_LABELERS);
    return forkHandoffAccessibleLabel(input, labels.target, labels.source);
  }
  const transition = `Context handoff from ${input.sources
    .map(contextHandoffEndpointAccessibleLabel)
    .join(", ")} to ${contextHandoffEndpointAccessibleLabel(input.target)}`;
  return `${transition}. ${contextHandoffStatusSuffix(input) ?? "Completed"}`;
}
