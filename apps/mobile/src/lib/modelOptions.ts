import type { ModelCapabilities, ModelSelection, ServerConfig } from "@ryco/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getModelSelectionBooleanOptionValue,
  getProviderOptionDescriptors,
} from "@ryco/shared/model";

import { shortModelName } from "./modelDisplayName";
import { providerDisplayLabel } from "./providerDisplay";

export type ModelOption = {
  readonly key: string;
  readonly label: string;
  readonly subtitle: string;
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly providerDriver: string;
  readonly isDefault: boolean;
  readonly capabilities: ModelCapabilities | null;
  readonly selection: ModelSelection;
};

export type ProviderGroup = {
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly models: ReadonlyArray<ModelOption>;
};

function normalizeSelectionOptions(
  selection: ModelSelection,
  capabilities: ModelCapabilities | null,
): ModelSelection {
  if (!capabilities) {
    return selection;
  }
  const options = buildProviderOptionSelectionsFromDescriptors(
    getProviderOptionDescriptors({
      caps: capabilities,
      selections: selection.options,
    }),
  );
  return options
    ? { ...selection, options }
    : {
        instanceId: selection.instanceId,
        model: selection.model,
      };
}

export function buildModelOptions(
  config: ServerConfig | null | undefined,
  fallbackModelSelection: ModelSelection | null,
): ReadonlyArray<ModelOption> {
  const options = new Map<string, ModelOption>();

  for (const provider of config?.providers ?? []) {
    if (!provider.enabled || !provider.installed || provider.auth.status === "unauthenticated") {
      continue;
    }

    const providerLabel =
      providerDisplayLabel(provider.driver, provider.displayName) ?? provider.instanceId;
    for (const model of provider.models) {
      const key = `${provider.instanceId}:${model.slug}`;
      options.set(key, {
        key,
        // The provider is already named by the group header and the pill glyph,
        // so "Claude Opus 4.8" reads as the provider twice. `subtitle` keeps the
        // full context for anywhere that needs it.
        label: shortModelName(model.name, providerLabel),
        subtitle: providerLabel,
        providerKey: provider.instanceId,
        providerLabel,
        providerDriver: provider.driver,
        // Ryco's ServerProviderModel contract carries no per-model default
        // marker (upstream did); no default badge is available here.
        isDefault: false,
        capabilities: model.capabilities,
        selection: normalizeSelectionOptions(
          {
            instanceId: provider.instanceId,
            model: model.slug,
          },
          model.capabilities,
        ),
      });
    }
  }

  if (fallbackModelSelection) {
    const key = `${fallbackModelSelection.instanceId}:${fallbackModelSelection.model}`;
    const existing = options.get(key);
    if (existing) {
      options.set(key, {
        ...existing,
        selection: normalizeSelectionOptions(fallbackModelSelection, existing.capabilities),
      });
    } else {
      const providerLabel = fallbackModelSelection.instanceId;
      options.set(key, {
        key,
        label: fallbackModelSelection.model,
        subtitle: providerLabel,
        providerKey: fallbackModelSelection.instanceId,
        providerLabel,
        providerDriver: fallbackModelSelection.instanceId,
        isDefault: false,
        capabilities: null,
        selection: fallbackModelSelection,
      });
    }
  }

  const currentKey = fallbackModelSelection
    ? `${fallbackModelSelection.instanceId}:${fallbackModelSelection.model}`
    : null;
  const fastMode = getModelSelectionBooleanOptionValue(
    currentKey ? options.get(currentKey)?.selection : null,
    "fastMode",
  );

  // Keep the user's Fast mode choice in both mobile model pickers, but only
  // send it to models that declare support for that option.
  return [...options.values()].map((option) => {
    if (
      option.key === currentKey ||
      fastMode === undefined ||
      !option.capabilities?.optionDescriptors?.some(
        (descriptor) => descriptor.id === "fastMode" && descriptor.type === "boolean",
      )
    ) {
      return option;
    }
    return {
      ...option,
      selection: normalizeSelectionOptions(
        {
          ...option.selection,
          options: [
            ...(option.selection.options ?? []).filter((value) => value.id !== "fastMode"),
            { id: "fastMode", value: fastMode },
          ],
        },
        option.capabilities,
      ),
    };
  });
}

export function groupByProvider(options: ReadonlyArray<ModelOption>): ReadonlyArray<ProviderGroup> {
  const groups = new Map<string, { providerLabel: string; models: ModelOption[] }>();
  for (const option of options) {
    const existing = groups.get(option.providerKey);
    if (existing) {
      existing.models.push(option);
    } else {
      groups.set(option.providerKey, {
        providerLabel: option.providerLabel,
        models: [option],
      });
    }
  }

  return [...groups.entries()].map(([providerKey, group]) => ({
    providerKey,
    providerLabel: group.providerLabel,
    models: group.models,
  }));
}
