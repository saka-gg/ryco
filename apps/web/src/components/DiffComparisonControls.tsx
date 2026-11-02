import type { GitComparisonSelection, GitReadComparisonResult } from "@ryco/contracts";
import { comparesWorkingTree } from "@ryco/client-runtime/state/comparison";
import { useState } from "react";

/** The mode select's value: the left endpoint, and whether the right one is the working files. */
type ComparisonModeValue =
  | GitComparisonSelection["mode"]
  | `${GitComparisonSelection["mode"]}:workingTree`;

const COMPARISON_MODE_LABEL: Record<ComparisonModeValue, string> = {
  mergeBase: "Branch changes → HEAD",
  "mergeBase:workingTree": "Branch changes → working tree",
  direct: "Commit to HEAD",
  "direct:workingTree": "Commit to working tree",
};

function comparisonModeValue(selection: GitComparisonSelection | null): ComparisonModeValue {
  if (!selection) return "mergeBase";
  return comparesWorkingTree(selection) ? `${selection.mode}:workingTree` : selection.mode;
}

function selectionOf(ref: string, value: ComparisonModeValue): GitComparisonSelection {
  const [mode, target] = value.split(":") as [GitComparisonSelection["mode"], string?];
  return target === "workingTree" ? { ref, mode, target: "workingTree" } : { ref, mode };
}

export function DiffComparisonControls(props: {
  selection: GitComparisonSelection | null;
  turnSelected?: boolean;
  data: GitReadComparisonResult | null;
  isLoading: boolean;
  error: string | null;
  refMoved: boolean;
  /** The node compares with the working files (`capabilities.workingTreeComparison`). */
  workingTreeAvailable?: boolean;
  onSelect: (selection: GitComparisonSelection | null) => void;
  onRefresh: () => void;
}) {
  const [draft, setDraft] = useState(props.selection?.ref ?? "");
  const [mode, setMode] = useState<ComparisonModeValue>(() => comparisonModeValue(props.selection));
  const workingTree = props.selection !== null && comparesWorkingTree(props.selection);
  // A saved working-tree selection stays listed on a node that cannot read it (it reports why).
  const modes: readonly ComparisonModeValue[] =
    props.workingTreeAvailable || workingTree
      ? ["mergeBase", "mergeBase:workingTree", "direct", "direct:workingTree"]
      : ["mergeBase", "direct"];
  return (
    <section
      className="shrink-0 border-b border-border px-3 py-2 text-xs"
      aria-label="Repository comparison"
    >
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          props.onSelect(selectionOf(draft.trim(), mode));
        }}
      >
        <button
          type="button"
          className="rounded border px-2 py-1"
          aria-pressed={props.turnSelected ?? !props.selection}
          onClick={() => props.onSelect(null)}
        >
          Turn review
        </button>
        <select
          aria-label="Comparison mode"
          className="app-glass-raised rounded border bg-background px-2 py-1"
          value={mode}
          onChange={(event) => setMode(event.target.value as ComparisonModeValue)}
        >
          {modes.map((value) => (
            <option key={value} value={value}>
              {COMPARISON_MODE_LABEL[value]}
            </option>
          ))}
        </select>
        <input
          aria-label="Branch, tag, or commit"
          placeholder="Branch, tag, or commit"
          className="app-glass-raised min-w-[160px] flex-1 rounded border bg-background px-2 py-1"
          value={draft}
          maxLength={256}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="rounded border px-2 py-1" disabled={!draft.trim()}>
          Compare
        </button>
        {props.selection && (
          <button
            type="button"
            className="rounded border px-2 py-1"
            onClick={props.onRefresh}
            disabled={props.isLoading}
          >
            Refresh comparison
          </button>
        )}
      </form>
      {props.selection && (
        <p className="mt-2 break-words text-muted-foreground">
          {props.selection.mode === "mergeBase" ? "Merge-base of" : "Commit"}{" "}
          <strong>{props.selection.ref}</strong>
          {props.selection.mode === "mergeBase" ? " and HEAD" : ""}
          {workingTree ? (
            <>
              {" "}
              → working tree. Includes staged, unstaged, and untracked changes; refresh to read
              later edits.
            </>
          ) : (
            <> → HEAD. Staged, unstaged, and untracked changes are excluded.</>
          )}
          {props.data && (
            <>
              {" "}
              Resolved {props.data.source.baseOid.slice(0, 8)} →{" "}
              {workingTree
                ? `working tree (HEAD ${props.data.source.headOid.slice(0, 8)})`
                : props.data.source.headOid.slice(0, 8)}
              .
            </>
          )}
          {props.refMoved && <> The selected reference moved; showing its current commits.</>}
        </p>
      )}
      {props.isLoading && (
        <p role="status" className="mt-2 text-muted-foreground">
          {props.data
            ? workingTree
              ? "Refreshing; showing the previous snapshot."
              : "Refreshing; showing the previous committed snapshot."
            : "Loading comparison…"}
        </p>
      )}
      {props.error && (
        <p role="alert" className="mt-2 text-destructive">
          {props.error}
        </p>
      )}
    </section>
  );
}
