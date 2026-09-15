import type { GitComparisonSelection, GitReadComparisonResult } from "@ryco/contracts";
import { useState } from "react";

export function DiffComparisonControls(props: {
  selection: GitComparisonSelection | null;
  data: GitReadComparisonResult | null;
  isLoading: boolean;
  error: string | null;
  refMoved: boolean;
  onSelect: (selection: GitComparisonSelection | null) => void;
  onRefresh: () => void;
}) {
  const [draft, setDraft] = useState(props.selection?.ref ?? "");
  const [mode, setMode] = useState<GitComparisonSelection["mode"]>(
    props.selection?.mode ?? "mergeBase",
  );
  return (
    <section
      className="shrink-0 border-b border-border px-3 py-2 text-xs"
      aria-label="Repository comparison"
    >
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          props.onSelect({ ref: draft.trim(), mode });
        }}
      >
        <button
          type="button"
          className="rounded border px-2 py-1"
          aria-pressed={!props.selection}
          onClick={() => props.onSelect(null)}
        >
          Turn review
        </button>
        <select
          aria-label="Comparison mode"
          className="rounded border bg-background px-2 py-1"
          value={mode}
          onChange={(event) => setMode(event.target.value as GitComparisonSelection["mode"])}
        >
          <option value="mergeBase">Branch changes → HEAD</option>
          <option value="direct">Commit to HEAD</option>
        </select>
        <input
          aria-label="Branch, tag, or commit"
          placeholder="Branch, tag, or commit"
          className="min-w-[160px] flex-1 rounded border bg-background px-2 py-1"
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
          {props.selection.mode === "mergeBase" ? " and HEAD" : ""} → HEAD. Staged, unstaged, and
          untracked changes are excluded.
          {props.data && (
            <>
              {" "}
              Resolved {props.data.source.baseOid.slice(0, 8)} →{" "}
              {props.data.source.headOid.slice(0, 8)}.
            </>
          )}
          {props.refMoved && <> The selected reference moved; showing its current commits.</>}
        </p>
      )}
      {props.isLoading && (
        <p role="status" className="mt-2 text-muted-foreground">
          {props.data
            ? "Refreshing; showing the previous committed snapshot."
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
