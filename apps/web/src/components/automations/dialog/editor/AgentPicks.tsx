/**
 * Who runs it: one quiet line of two labelled picks — Model (the app's model
 * picker with its effort dial, in one popover) and Permissions (the app's
 * runtime modes). Picking a model with the pointer keeps the popover open so
 * the dial can be turned next; Enter, or picking the current one, closes it.
 */
import { scheduleModelLabel } from "@ryco/client-runtime/state/agentControl";
import type { ModelSelection, RuntimeMode, ServerProvider } from "@ryco/contracts";
import { fitScheduleModelOptions } from "@ryco/shared/automationSchedule";
import { createModelSelection } from "@ryco/shared/model";
import { ChevronsUpDownIcon } from "lucide-react";
import { useMemo, type KeyboardEvent } from "react";

import { useSettings } from "../../../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../../../modelSelection";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../../../providerInstances";
import { ModelPickerContent } from "../../../chat/ModelPickerContent";
import { ComposerModelTuning } from "../../../chat/ModelTuningDial";
import { ProviderInstanceIcon } from "../../../chat/ProviderInstanceIcon";
import { runtimeModeConfig, runtimeModeOptions } from "../../../chat/sessionPolicyPresentation";
import type { EditorTokenKind } from "./editorModel.logic";
import { modelMissing } from "./editorModel.logic";
import { ModelPickPopover, TokenMenu } from "./tokenPopups";

const noop = () => undefined;

export interface AgentPicksProps {
  readonly editorId: string;
  readonly selection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  /** The device's providers (its models and effort options). */
  readonly providers: ReadonlyArray<ServerProvider>;
  /** The model can't be used (gone, or none picked): the pick is outlined. */
  readonly modelInvalid: boolean;
  /** The message that says why (`aria-describedby`), when there is one. */
  readonly modelMessageId?: string | undefined;
  readonly openKind: EditorTokenKind | null;
  readonly onOpenChange: (kind: EditorTokenKind, open: boolean) => void;
  readonly onTokenKeyDown: (kind: EditorTokenKind, event: KeyboardEvent<HTMLButtonElement>) => void;
  readonly onModel: (selection: ModelSelection) => void;
  readonly onRuntimeMode: (mode: RuntimeMode) => void;
}

export function AgentPicks(props: AgentPicksProps) {
  const { editorId, selection, providers } = props;
  const settings = useSettings();
  const entries = useMemo(
    () => sortProviderInstanceEntries(deriveProviderInstanceEntries(providers)),
    [providers],
  );
  const optionsByInstance = useMemo(
    () =>
      getCustomModelOptionsByInstance(
        settings,
        [...providers],
        selection.instanceId,
        selection.model,
      ),
    [providers, selection.instanceId, selection.model, settings],
  );
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  const missing = modelMissing(selection);
  const modelLabel = missing
    ? "Pick a model"
    : scheduleModelLabel(selection, providers, { effort: true });
  const modelOpen = props.openKind === "model";

  const tuning =
    provider && !missing ? (
      <ComposerModelTuning
        provider={provider.driver}
        instanceId={provider.instanceId}
        models={provider.models}
        model={selection.model}
        prompt=""
        onPromptChange={noop}
        modelOptions={selection.options}
        onModelOptionsChange={(options) =>
          props.onModel(createModelSelection(selection.instanceId, selection.model, options))
        }
      />
    ) : null;

  return (
    <div className="ae-agent">
      <ModelPickPopover
        editorId={editorId}
        open={modelOpen}
        onOpenChange={(next) => props.onOpenChange("model", next)}
        trigger={
          <button
            type="button"
            className="ae-pick"
            data-tok="model"
            data-invalid={props.modelInvalid ? "" : undefined}
            aria-invalid={props.modelInvalid ? true : undefined}
            aria-describedby={props.modelMessageId}
            aria-label={`Model: ${modelLabel}`}
            onKeyDown={(event) => props.onTokenKeyDown("model", event)}
          >
            <span className="ae-pick-l">Model</span>
            {provider ? (
              <ProviderInstanceIcon
                driverKind={provider.driver}
                displayName={provider.displayName ?? provider.instanceId}
                className="ae-prov"
                iconClassName="size-3.5"
              />
            ) : null}
            <span className="ad-trunc">{modelLabel}</span>
            <ChevronsUpDownIcon className="ae-pick-ic" aria-hidden="true" />
          </button>
        }
      >
        <ModelPickerContent
          activeInstanceId={selection.instanceId}
          model={selection.model}
          modelOptions={selection.options}
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={optionsByInstance}
          terminalOpen={false}
          {...(tuning ? { tuning } : {})}
          onRequestClose={() => props.onOpenChange("model", false)}
          onInstanceModelChange={(instanceId, model, options, meta) => {
            // Same provider: keep the effort; another: its own default.
            const kept =
              options ?? (instanceId === selection.instanceId ? selection.options : undefined);
            // Only the options the picked model offers survive the switch.
            props.onModel(
              fitScheduleModelOptions(createModelSelection(instanceId, model, kept), providers),
            );
            if (!meta?.keepOpen) props.onOpenChange("model", false);
          }}
        />
      </ModelPickPopover>
      <TokenMenu
        editorId={editorId}
        kind="mode"
        label="Permissions"
        wide
        open={props.openKind === "mode"}
        onOpenChange={(next) => props.onOpenChange("mode", next)}
        value={props.runtimeMode}
        items={runtimeModeOptions.map((mode) => ({
          value: mode,
          label: runtimeModeConfig[mode].label,
          hint: runtimeModeConfig[mode].description,
        }))}
        onPick={props.onRuntimeMode}
        trigger={
          <button
            type="button"
            className="ae-pick"
            data-tok="mode"
            aria-label={`Permissions: ${runtimeModeConfig[props.runtimeMode].label}`}
            onKeyDown={(event) => props.onTokenKeyDown("mode", event)}
          >
            <span className="ae-pick-l">Permissions</span>
            <span>{runtimeModeConfig[props.runtimeMode].label}</span>
            <ChevronsUpDownIcon className="ae-pick-ic" aria-hidden="true" />
          </button>
        }
      />
    </div>
  );
}
