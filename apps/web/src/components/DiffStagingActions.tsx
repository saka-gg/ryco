import type {
  GitApplyIndexPatchInput,
  GitLocalChangesResult,
  GitLocalChangesScope,
} from "@ryco/contracts";
import { useState } from "react";

export function DiffStagingActions(props: {
  scope: GitLocalChangesScope;
  file: GitLocalChangesResult["staged"]["files"][number];
  name: string;
  disabled: boolean;
  onApply: (input: Pick<GitApplyIndexPatchInput, "scope" | "fileId" | "hunkIndex">) => void;
}) {
  const [hunk, setHunk] = useState(0);
  const verb = props.scope === "staged" ? "Unstage" : "Stage";
  return (
    <span className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        className="rounded px-2 py-1 text-xs hover:bg-foreground/10 disabled:opacity-50"
        aria-label={`${verb} file ${props.name}`}
        disabled={props.disabled || !props.file.fileAction}
        title={
          !props.file.fileAction
            ? "Symlink and submodule changes require external Git review."
            : undefined
        }
        onClick={() => props.onApply({ scope: props.scope, fileId: props.file.id })}
      >
        {verb} file
      </button>
      {props.file.hunkAction && (
        <>
          <select
            aria-label={`Hunk in ${props.name}`}
            className="max-w-28 rounded border bg-background text-xs"
            disabled={props.disabled}
            value={hunk}
            onChange={(event) => setHunk(Number(event.target.value))}
          >
            {Array.from({ length: props.file.hunkCount }, (_, index) => (
              <option key={index} value={index}>
                Hunk {index + 1}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="rounded px-2 py-1 text-xs hover:bg-foreground/10 disabled:opacity-50"
            aria-label={`${verb} hunk ${hunk + 1} in ${props.name}`}
            disabled={props.disabled}
            onClick={() =>
              props.onApply({ scope: props.scope, fileId: props.file.id, hunkIndex: hunk })
            }
          >
            {verb} hunk
          </button>
        </>
      )}
    </span>
  );
}
