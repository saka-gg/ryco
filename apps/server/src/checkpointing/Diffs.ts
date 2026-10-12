// The subpath loads only the parser; the package root pulls in shiki and the
// whole highlighting stack.
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";

export interface TurnDiffFileSummary {
  readonly path: string;
  readonly kind: string;
  readonly additions: number;
  readonly deletions: number;
}

export function parseTurnDiffFilesFromUnifiedDiff(
  diff: string,
): ReadonlyArray<TurnDiffFileSummary> {
  const normalized = diff.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return [];
  }

  const parsedPatches = parsePatchFiles(normalized);
  const files = parsedPatches.flatMap((patch) =>
    patch.files.filter(isMeaningfulPatchFile).map((file) => ({
      path: file.name,
      kind: normalizePatchFileKind(file),
      additions: file.hunks.reduce((total, hunk) => total + hunk.additionLines, 0),
      deletions: file.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0),
    })),
  );

  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

type ParsedPatchFile = ReturnType<typeof parsePatchFiles>[number]["files"][number];

function isMeaningfulPatchFile(file: ParsedPatchFile): boolean {
  if (file.hunks.length > 0) {
    return true;
  }
  if (file.type !== "change") {
    return true;
  }
  if (file.prevName) {
    return true;
  }
  if (file.prevMode !== undefined && file.mode !== undefined && file.prevMode !== file.mode) {
    return true;
  }
  return false;
}

function normalizePatchFileKind(file: ParsedPatchFile): string {
  if (file.type === "new") {
    return "added";
  }
  if (file.type === "deleted") {
    return "deleted";
  }
  if (file.type.startsWith("rename")) {
    return "renamed";
  }
  if (file.hunks.length === 0 && file.prevMode !== undefined && file.mode !== undefined) {
    return "mode-changed";
  }
  return "modified";
}
