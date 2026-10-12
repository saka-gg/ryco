import {
  resolvePendingComposerHandoff,
  type PendingComposerHandoff,
} from "@ryco/client-runtime/state/session";
import type {
  ContextHandoffEndpointSnapshot,
  ModelSelection,
  OrchestrationThreadActivity,
} from "@ryco/contracts";
import { getModelDisplayLabel, modelSelectionRequiresContextHandoff } from "@ryco/shared/model";

import type { AppModelOption } from "../../modelSelection";
import type { ProviderInstanceEntry } from "../../providerInstances";

export interface PendingContextHandoffPresentation {
  readonly source: ContextHandoffEndpointSnapshot;
  readonly target: ContextHandoffEndpointSnapshot;
}

function resolveEndpoint(input: {
  readonly selection: ModelSelection;
  readonly providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<
    ModelSelection["instanceId"],
    ReadonlyArray<AppModelOption>
  >;
}): ContextHandoffEndpointSnapshot | null {
  const entry = input.providerInstanceEntries.find(
    (candidate) => candidate.instanceId === input.selection.instanceId,
  );
  if (!entry) return null;

  const model =
    input.modelOptionsByInstance
      .get(input.selection.instanceId)
      ?.find((candidate) => candidate.slug === input.selection.model) ??
    entry.models.find((candidate) => candidate.slug === input.selection.model);

  return {
    providerInstanceId: entry.instanceId,
    driverKind: entry.driverKind,
    providerDisplayName: entry.displayName,
    ...(entry.accentColor ? { providerAccentColor: entry.accentColor } : {}),
    modelSlug: input.selection.model,
    ...(model ? { modelDisplayName: getModelDisplayLabel(model, { preferShortName: true }) } : {}),
  };
}

export function derivePendingContextHandoff(input: {
  readonly threadStarted: boolean;
  readonly isPhoneTier: boolean;
  readonly canonicalSelection: ModelSelection | null | undefined;
  readonly targetSelection: ModelSelection;
  readonly providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<
    ModelSelection["instanceId"],
    ReadonlyArray<AppModelOption>
  >;
}): PendingContextHandoffPresentation | null {
  if (!input.threadStarted || input.isPhoneTier || !input.canonicalSelection) {
    return null;
  }
  if (
    !modelSelectionRequiresContextHandoff({
      canonicalSelection: input.canonicalSelection,
      targetSelection: input.targetSelection,
    })
  ) {
    return null;
  }

  const source = resolveEndpoint({
    selection: input.canonicalSelection,
    providerInstanceEntries: input.providerInstanceEntries,
    modelOptionsByInstance: input.modelOptionsByInstance,
  });
  const target = resolveEndpoint({
    selection: input.targetSelection,
    providerInstanceEntries: input.providerInstanceEntries,
    modelOptionsByInstance: input.modelOptionsByInstance,
  });

  return source && target ? { source, target } : null;
}

/**
 * What the composer says about the next message's context handoff, by the
 * shared precedence (`resolvePendingComposerHandoff`): a fork that still owes a
 * fresh session its inherited conversation takes the model chip's place (the
 * node starts that turn with a "fork" handoff whichever model is selected),
 * else the model change. The frozen phone tier offers no handoff chips.
 */
export function derivePendingComposerHandoff(input: {
  readonly isPhoneTier: boolean;
  readonly activities:
    | ReadonlyArray<Pick<OrchestrationThreadActivity, "kind" | "payload">>
    | null
    | undefined;
  readonly modelChange: PendingContextHandoffPresentation | null;
}): PendingComposerHandoff<PendingContextHandoffPresentation> | null {
  if (input.isPhoneTier) return null;
  return resolvePendingComposerHandoff({
    activities: input.activities,
    modelChange: () => input.modelChange,
  });
}
