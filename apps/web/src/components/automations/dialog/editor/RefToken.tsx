/**
 * "off [main]": the branch a worktree run starts from. Typing narrows the
 * device's refs at once and asks the server for the rest (the ref search the
 * pull request dialog's branch picker uses); the current value always stays
 * pickable, even before the list loads. Its items read like the editor's
 * other token menus (the lab's `menuPop`): branch icon, name, check on the
 * right.
 */
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import type { EnvironmentId, VcsRef } from "@ryco/contracts";
import { CheckIcon, GitBranchIcon } from "lucide-react";
import { useMemo, useState, type KeyboardEvent } from "react";

import { branchSearchEmptyText, useGitBranchSearch } from "../../../../rpc/useGitBranchSearch";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxStatus,
  ComboboxTrigger,
} from "../../../ui/combobox";
import { tokenAnchor, tokenPopupId } from "./tokenAnchor";

const REF_GAP = 6;

/** Local branches first, then remote-tracking ones; the current value leads; no symbolic HEADs. */
export function refChoices(current: string, refs: ReadonlyArray<VcsRef>): string[] {
  const names = new Set<string>();
  if (current) names.add(current);
  for (const ref of refs) if (!ref.isRemote) names.add(ref.name);
  for (const ref of refs)
    if (ref.isRemote && !ref.name.endsWith("/HEAD") && ref.name !== "HEAD") names.add(ref.name);
  return [...names];
}

export function RefToken(props: {
  readonly editorId: string;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly value: string;
  /** What the token reads; the server's default (HEAD) when no branch is set. */
  readonly display: string;
  readonly label: string;
  /** The message about this branch (a refused save), when there is one. */
  readonly messageId?: string | undefined;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (ref: string) => void;
  readonly onTokenKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const { editorId, environmentId, cwd, open } = props;
  const [query, setQuery] = useState("");
  const search = useGitBranchSearch({ environmentId, cwd, open, query });
  const items = useMemo(() => refChoices(props.value, search.refs), [props.value, search.refs]);
  const filtered = useMemo(() => items.filter(search.matches), [items, search.matches]);
  const anchor = useMemo(() => tokenAnchor(editorId, "ref", REF_GAP), [editorId]);

  return (
    <Combobox
      items={items}
      filteredItems={filtered}
      autoHighlight
      open={open}
      value={props.value}
      onOpenChange={(next) => {
        props.onOpenChange(next);
        if (!next) setQuery("");
      }}
      onValueChange={(next) => {
        if (typeof next === "string" && next) props.onPick(next);
      }}
    >
      <ComboboxTrigger
        render={
          <button
            type="button"
            className="ae-tok ae-tok-ref"
            data-tok="ref"
            data-invalid={props.messageId ? "" : undefined}
            aria-invalid={props.messageId ? true : undefined}
            aria-describedby={props.messageId}
            aria-label={props.label}
            onKeyDown={props.onTokenKeyDown}
          />
        }
      >
        {props.display}
      </ComboboxTrigger>
      <ComboboxPopup
        anchor={anchor}
        align="start"
        sideOffset={REF_GAP}
        className="ae-ref-pop w-72"
        aria-label="Branch"
        data-ae-pop={tokenPopupId(editorId, "ref")}
      >
        <div className="border-b p-1">
          <ComboboxInput
            aria-label="Find a branch"
            className="rounded-md"
            inputClassName="ring-0"
            placeholder="Find a branch"
            showTrigger={false}
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <ComboboxEmpty>
          {branchSearchEmptyText(search.isPending && items.length <= 1)}
        </ComboboxEmpty>
        <ComboboxList aria-label="Branch" className="max-h-64">
          {filtered.map((name, index) => (
            <ComboboxItem
              key={name}
              index={index}
              value={name}
              hideIndicator
              className="ae-ref-item"
              contentClassName="ae-ref-item-c"
            >
              <GitBranchIcon aria-hidden="true" className="ae-ref-item-ic" />
              <span className="ae-ref-item-l">{name}</span>
              <ComboboxPrimitive.ItemIndicator className="ae-ref-item-ck">
                <CheckIcon aria-hidden="true" />
              </ComboboxPrimitive.ItemIndicator>
            </ComboboxItem>
          ))}
        </ComboboxList>
        {search.status ? <ComboboxStatus>{search.status}</ComboboxStatus> : null}
      </ComboboxPopup>
    </Combobox>
  );
}
