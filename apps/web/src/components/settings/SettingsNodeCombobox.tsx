import { EnvironmentId } from "@ryco/contracts";
import { useState, type ReactElement, type ReactNode } from "react";

import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "../ui/combobox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { SettingsNodeChoice, SettingsNodeMenuModel } from "./SettingsNodeMenu";

/**
 * `SettingsNodeMenu` for more than six devices: the same choices, gate and
 * switch, with a search field. Its own chunk, loaded only for such a list.
 */
export function SettingsNodeCombobox(props: {
  readonly model: SettingsNodeMenuModel;
  readonly trigger: ReactElement;
  readonly tooltip?: string | undefined;
  readonly tooltipSide?: "top" | "right" | "bottom" | undefined;
  readonly renderChoice: (choice: SettingsNodeChoice) => ReactNode;
}) {
  const { model } = props;
  const [query, setQuery] = useState("");
  const trigger = <ComboboxTrigger render={props.trigger} />;
  const needle = query.trim().toLowerCase();
  const filtered = model.choices.filter((choice) => choice.label.toLowerCase().includes(needle));
  return (
    <Combobox
      items={model.choices.map((choice) => choice.environmentId as string)}
      filteredItems={filtered.map((choice) => choice.environmentId as string)}
      autoHighlight
      value={model.value}
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
      onValueChange={(next) => {
        if (typeof next === "string") model.select(EnvironmentId.make(next));
      }}
    >
      {props.tooltip ? (
        <Tooltip>
          <TooltipTrigger render={trigger} />
          <TooltipPopup side={props.tooltipSide ?? "top"}>{props.tooltip}</TooltipPopup>
        </Tooltip>
      ) : (
        trigger
      )}
      <ComboboxPopup align="start" className="w-72 overflow-hidden">
        <div className="border-b p-1">
          <ComboboxInput
            className="[&_input]:font-sans rounded-md"
            inputClassName="ring-0"
            placeholder="Search devices…"
            aria-label="Search devices"
            showTrigger={false}
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <ComboboxEmpty>No devices match.</ComboboxEmpty>
        <ComboboxList className="max-h-64">
          {filtered.map((choice, index) => (
            <ComboboxItem
              key={choice.environmentId}
              index={index}
              value={choice.environmentId}
              disabled={choice.disabled}
            >
              {props.renderChoice(choice)}
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
