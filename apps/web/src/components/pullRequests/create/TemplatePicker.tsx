import type { ChangeRequestTemplate } from "@ryco/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { Button } from "../../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "../../ui/combobox";
import { templateOptionLabels } from "./createPullRequest.logic";

// Template paths end in `.md` or `.txt`, so this never names one.
const NO_TEMPLATE = "no-template";

/**
 * "Template" above the description: the repository's templates, default first. Locked once
 * the author changed the text a template put in (clearing it unlocks the picker). The same
 * searchable list as the branch pickers beside it, so the dialog loads no other popup code.
 */
export function TemplatePicker(props: {
  readonly templates: ReadonlyArray<ChangeRequestTemplate>;
  readonly selectedPath: string | null;
  readonly locked: boolean;
  readonly disabled: boolean;
  readonly onChoose: (path: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const labels = useMemo(
    () =>
      new Map<string, string>([
        [NO_TEMPLATE, "No template"],
        ...templateOptionLabels(props.templates),
      ]),
    [props.templates],
  );
  const items = useMemo(() => [...labels.keys()], [labels]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? items.filter((value) => labels.get(value)?.toLowerCase().includes(needle))
      : items;
  }, [items, labels, query]);
  const value =
    props.selectedPath !== null && labels.has(props.selectedPath)
      ? props.selectedPath
      : NO_TEMPLATE;
  const label = labels.get(value) ?? "No template";

  const choose = (next: string) => {
    setOpen(false);
    setQuery("");
    props.onChoose(next === NO_TEMPLATE ? null : next);
  };

  return (
    <div
      className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground"
      title={props.locked ? "Clear the description to switch templates" : undefined}
    >
      <span aria-hidden>Template</span>
      <Combobox
        items={items}
        filteredItems={filtered}
        autoHighlight
        open={open}
        value={value}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
      >
        <ComboboxTrigger
          ref={triggerRef}
          aria-label={`Template: ${label}`}
          disabled={props.disabled || props.locked}
          render={<Button type="button" variant="ghost" size="xs" />}
          className="min-w-0 max-w-56 justify-between gap-1 font-medium"
        >
          <span className="truncate">{label}</span>
          <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 opacity-60" />
        </ComboboxTrigger>
        <ComboboxPopup anchor={triggerRef} align="end" className="w-64 overflow-hidden">
          <div className="border-b p-1">
            <ComboboxInput
              aria-label="Find a template"
              className="rounded-md"
              inputClassName="ring-0"
              placeholder="Find a template"
              showTrigger={false}
              size="sm"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <ComboboxEmpty>No matching template</ComboboxEmpty>
          <ComboboxList aria-label="Templates" className="max-h-64">
            {filtered.map((item, index) => (
              <ComboboxItem key={item} index={index} value={item} onClick={() => choose(item)}>
                <span className="truncate">{labels.get(item)}</span>
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    </div>
  );
}
