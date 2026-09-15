import type { EnvironmentId, GitComparisonSource, GitReadLineBlameResult } from "@ryco/contracts";
import {
  createLineBlameReader,
  displayedBlameTarget,
  type BlameFile,
} from "@ryco/client-runtime/state/comparison/lineBlame";
import { useEffect, useMemo, useState } from "react";
import { ensureEnvironmentApi } from "../environmentApi";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "./ui/dialog";
import { Button } from "./ui/button";

export function DiffLineBlame(props: {
  environmentId: EnvironmentId;
  source: GitComparisonSource;
  file: BlameFile;
  initialSide: "base" | "head";
  initialLine: number;
  onClose: () => void;
}) {
  const [side, setSide] = useState(props.initialSide);
  const [line, setLine] = useState(String(props.initialLine));
  const [request, setRequest] = useState({ side: props.initialSide, line: props.initialLine });
  const reader = useMemo(
    () =>
      createLineBlameReader({
        environmentId: props.environmentId,
        source: props.source,
        read: (input) => ensureEnvironmentApi(props.environmentId).vcs.readLineBlame(input),
      }),
    [props.environmentId, props.source],
  );
  const [outcome, setOutcome] = useState<{
    request: typeof request;
    reader: typeof reader;
    result: GitReadLineBlameResult | null;
    error: string | null;
  } | null>(null);
  const target = useMemo(
    () => displayedBlameTarget(props.file, request.side, request.line),
    [props.file, request],
  );
  const currentOutcome = outcome?.request === request && outcome.reader === reader ? outcome : null;
  const result = target ? currentOutcome?.result : null;
  const error = target
    ? currentOutcome?.error
    : "Choose a displayed context or deleted line. Added lines have no blame here.";
  const loading = target !== null && currentOutcome === null;
  useEffect(() => () => reader.invalidate(), [reader]);
  useEffect(() => {
    let current = true;
    if (!target) return;
    void reader.read(target).then(
      (value) => {
        if (current) setOutcome({ request, reader, result: value, error: null });
      },
      () => {
        if (current)
          setOutcome({
            request,
            reader,
            result: null,
            error: "Blame unavailable. Retry or refresh the comparison.",
          });
      },
    );
    return () => {
      current = false;
    };
  }, [reader, target, request]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-md p-5">
        <DialogTitle>Line blame</DialogTitle>
        <DialogDescription className="mt-1 break-all">{props.file.name}</DialogDescription>
        <form
          className="mt-4 flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setRequest({ side, line: Number(line) });
          }}
        >
          <label className="flex flex-col gap-1 text-xs">
            Side
            <select
              className="h-8 rounded border bg-background px-2"
              value={side}
              onChange={(event) => setSide(event.target.value as "base" | "head")}
            >
              <option value="base">Base</option>
              <option value="head">Head</option>
            </select>
          </label>
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
            Line
            <input
              className="h-8 w-full rounded border bg-background px-2"
              type="number"
              min="1"
              step="1"
              required
              value={line}
              onChange={(event) => setLine(event.target.value)}
            />
          </label>
          <Button type="submit" size="sm" disabled={loading}>
            Look up
          </Button>
        </form>
        <div className="mt-4 min-h-24 space-y-2 text-sm" aria-live="polite" aria-busy={loading}>
          <p className="text-xs text-muted-foreground">
            {request.side === "base" ? "Base" : "Head"} line {request.line} ·{" "}
            <span className="font-mono">
              {(request.side === "base" ? props.source.baseOid : props.source.headOid).slice(0, 12)}
            </span>
          </p>
          {loading && <p>Loading blame…</p>}
          {error && <p role="status">{error}</p>}
          {result?.kind === "unavailable" && <p>{result.reason}</p>}
          {result?.kind === "committed" && (
            <>
              <p className="break-words font-medium">{result.summary}</p>
              <p className="break-words text-muted-foreground">
                {result.author}
                {result.authorTime ? ` · ${new Date(result.authorTime).toLocaleDateString()}` : ""}
              </p>
              <p className="break-all font-mono text-xs" title={result.oid}>
                {result.oid}
              </p>
            </>
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
