import { UsersIcon } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";

import { cn } from "../../../lib/utils";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxStatus,
  ComboboxTrigger,
} from "../../ui/combobox";
import { ActorAvatar } from "../primitives";
import { diffPickerSelection, filterPickerCandidates, type ListEdit } from "./peopleFacts.logic";

export interface PickerOption {
  readonly value: string;
  /** Second line (display name, team, label description, or why it is fixed). */
  readonly detail?: string | undefined;
  readonly avatarUrl?: string | undefined;
  /** Label colour (hex without `#`). */
  readonly color?: string | undefined;
  readonly kind: "person" | "team" | "label";
  /** Marks a person who already reviewed (re-requesting asks again). */
  readonly trailing?: ReactNode;
}

/**
 * A multi-select picker for reviewers, assignees or labels. Edits stay local
 * while it is open; closing it applies one `{ add, remove }` edit (nothing
 * when the selection did not change). Selected values stay pinned on top for
 * the whole session so rows do not jump while toggling.
 */
export function PickerPopover(props: {
  readonly label: string;
  readonly placeholder: string;
  readonly selected: ReadonlyArray<string>;
  readonly options: ReadonlyArray<PickerOption>;
  readonly loading: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onApply: (edit: ListEdit) => void;
  /** The trigger's contents (a section label row). */
  readonly children: ReactNode;
  readonly triggerClassName?: string | undefined;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState<ReadonlyArray<string>>(props.selected);
  const [pinned, setPinned] = useState<ReadonlyArray<string>>(props.selected);
  const [query, setQuery] = useState("");
  const byValue = useMemo(
    () => new Map(props.options.map((option) => [option.value, option] as const)),
    [props.options],
  );
  const values = useMemo(() => props.options.map((option) => option.value), [props.options]);
  const filtered = useMemo(
    () =>
      filterPickerCandidates(values, pinned, query, (value) => byValue.get(value)?.detail ?? value),
    [byValue, pinned, query, values],
  );

  // Every opening (a click, or a request from elsewhere) starts from the
  // current selection.
  const [wasOpen, setWasOpen] = useState(props.open);
  if (props.open !== wasOpen) {
    setWasOpen(props.open);
    if (props.open) {
      setDraft(props.selected);
      setPinned(props.selected);
      setQuery("");
    }
  }

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      // Against the selection the picker opened with, so a refresh while it
      // was open cannot turn into an edit the user never made.
      const edit = diffPickerSelection(pinned, draft);
      if (edit) props.onApply(edit);
    }
    props.onOpenChange(open);
  };

  return (
    <Combobox<string, true>
      multiple
      items={values as string[]}
      filteredItems={filtered as string[]}
      value={draft as string[]}
      onValueChange={(next) => setDraft(next)}
      open={props.open}
      onOpenChange={handleOpenChange}
      autoHighlight
    >
      <ComboboxTrigger
        ref={triggerRef}
        aria-label={`Edit ${props.label.toLowerCase()}`}
        className={props.triggerClassName}
        render={<button type="button" />}
      >
        {props.children}
      </ComboboxTrigger>
      <ComboboxPopup anchor={triggerRef} align="end" side="bottom" sideOffset={6} className="w-64">
        <div className="border-b border-border/60 p-1">
          <ComboboxInput
            className="rounded-md [&_input]:font-sans"
            inputClassName="ring-0"
            placeholder={props.placeholder}
            showTrigger={false}
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {props.loading && props.options.length === 0 ? (
          <ComboboxStatus>Loading…</ComboboxStatus>
        ) : null}
        <ComboboxEmpty>No matches.</ComboboxEmpty>
        <ComboboxList className="max-h-64">
          {filtered.map((value, index) => {
            const option = byValue.get(value);
            if (!option) return null;
            return (
              <ComboboxItem key={value} value={value} index={index}>
                <PickerRow option={option} />
              </ComboboxItem>
            );
          })}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

function PickerRow({ option }: { readonly option: PickerOption }) {
  return (
    <span className="flex min-w-0 items-center gap-2 py-0.5">
      {option.kind === "label" ? (
        <LabelDot color={option.color} />
      ) : option.kind === "team" ? (
        <span className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <UsersIcon className="size-3" aria-hidden />
        </span>
      ) : (
        <ActorAvatar login={option.value} avatarUrl={option.avatarUrl} size={18} />
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px]">{option.value}</span>
        {option.detail ? (
          <span className="truncate text-xs text-muted-foreground">{option.detail}</span>
        ) : null}
      </span>
      {option.trailing}
    </span>
  );
}

const HEX6 = /^[0-9a-f]{6}$/iu;

/** A label's colour as a small dot (labels read by name, not by fill). */
export function LabelDot(props: {
  readonly color?: string | undefined;
  readonly className?: string;
}) {
  const color = props.color?.replace(/^#/u, "");
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        !color || !HEX6.test(color) ? "bg-muted-foreground/50" : null,
        props.className,
      )}
      style={color && HEX6.test(color) ? { backgroundColor: `#${color}` } : undefined}
    />
  );
}
