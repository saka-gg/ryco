import type { EnvironmentId, VcsRef } from "@ryco/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useDeferredValue, useMemo, useRef, useState } from "react";

import { useGitBranches } from "../../../rpc/useGit";
import { Button } from "../../ui/button";
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
import { branchFromRef, type CreatePullRequestBranch } from "./createPullRequest.logic";

interface PickableRef {
  readonly ref: VcsRef;
  readonly branch: CreatePullRequestBranch;
}

function pickableRefs(refs: ReadonlyArray<VcsRef>): Map<string, PickableRef> {
  const byRefName = new Map<string, PickableRef>();
  for (const ref of refs) {
    const branch = branchFromRef(ref);
    if (branch && !byRefName.has(branch.refName)) byRefName.set(branch.refName, { ref, branch });
  }
  return byRefName;
}

/**
 * One side of the dialog's branch line: a searchable list of local and
 * `origin` branches (the existing ref search, paged by the server). Typing
 * narrows the loaded refs at once and asks the server for the rest.
 */
export function BranchPicker(props: {
  /** "Head branch" / "Base branch": the trigger's accessible name and the list's. */
  readonly label: string;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly value: CreatePullRequestBranch | null;
  readonly onChange: (branch: CreatePullRequestBranch) => void;
  /** A muted word beside a ref ("current", "default"). */
  readonly tagFor: (ref: VcsRef) => string | null;
  /** Trigger text while nothing is picked. */
  readonly placeholder: string;
}) {
  const { environmentId, cwd } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // The unfiltered first page is the dialog's own read (shared cache); a
  // query reads the server's matches once typing settles.
  const all = useGitBranches({ environmentId, cwd: open ? cwd : null, query: "" });
  const searched = useGitBranches({
    environmentId,
    cwd: open && deferredQuery.length > 0 ? cwd : null,
    query: deferredQuery,
  });
  const source = deferredQuery.length > 0 && !searched.isPending ? searched : all;
  const byRefName = useMemo(() => pickableRefs(source.refs), [source.refs]);
  const items = useMemo(() => [...byRefName.keys()], [byRefName]);
  const needle = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      needle.length === 0 ? items : items.filter((name) => name.toLowerCase().includes(needle)),
    [items, needle],
  );

  const choose = (refName: string) => {
    const entry = byRefName.get(refName);
    setOpen(false);
    setQuery("");
    if (entry) props.onChange(entry.branch);
  };

  const statusText = source.isPending
    ? null
    : source.hasNextPage
      ? `Showing ${source.refs.length} of ${source.totalCount} · type to narrow`
      : null;

  return (
    <Combobox
      items={items}
      filteredItems={filtered}
      autoHighlight
      open={open}
      value={props.value?.refName ?? null}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <ComboboxTrigger
        ref={triggerRef}
        aria-label={`${props.label}: ${props.value?.name ?? "none"}`}
        render={<Button type="button" variant="outline" size="sm" />}
        className="min-w-0 max-w-[15rem] justify-between gap-1.5 px-2 font-mono text-xs font-normal"
      >
        <span className={props.value ? "truncate" : "truncate text-muted-foreground"}>
          {props.value?.name ?? props.placeholder}
        </span>
        <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 opacity-60" />
      </ComboboxTrigger>
      <ComboboxPopup anchor={triggerRef} align="start" className="w-80 overflow-hidden">
        <div className="border-b p-1">
          <ComboboxInput
            aria-label={`Find a ${props.label.toLowerCase()}`}
            className="rounded-md [&_input]:font-sans"
            inputClassName="ring-0"
            placeholder="Find a branch"
            showTrigger={false}
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <ComboboxEmpty>
          {source.isPending && items.length === 0 ? "Loading branches…" : "No branches match."}
        </ComboboxEmpty>
        <ComboboxList aria-label={props.label} className="max-h-64">
          {filtered.map((refName, index) => {
            const entry = byRefName.get(refName);
            if (!entry) return null;
            const tag = props.tagFor(entry.ref);
            return (
              <ComboboxItem
                key={refName}
                index={index}
                value={refName}
                onClick={() => choose(refName)}
              >
                <span className="flex min-w-0 items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs">{refName}</span>
                  {tag ? (
                    <span className="shrink-0 text-[10px] text-muted-foreground">{tag}</span>
                  ) : null}
                </span>
              </ComboboxItem>
            );
          })}
        </ComboboxList>
        {statusText ? <ComboboxStatus>{statusText}</ComboboxStatus> : null}
      </ComboboxPopup>
    </Combobox>
  );
}
