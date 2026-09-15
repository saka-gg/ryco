import type {
  GitComparisonSource,
  GitReadLineBlameInput,
  GitReadLineBlameResult,
} from "@ryco/contracts";
import { comparisonFileKey } from "./index.ts";

export interface LineBlameTarget {
  side: "base" | "head";
  filePath: string;
  line: number;
}
/** The renderer supplies hunk structure; no DOM or renderer runtime enters shared policy. */
export interface BlameFile {
  name: string;
  prevName?: string;
  hunks: readonly {
    deletionStart: number;
    additionStart: number;
    hunkContent: readonly (
      | { type: "context"; lines: number }
      | { type: "change"; deletions: number; additions: number }
    )[];
  }[];
}
export function displayedBlameTarget(
  file: BlameFile,
  side: "base" | "head",
  line: number,
): LineBlameTarget | null {
  if (!Number.isSafeInteger(line) || line < 1) return null;
  const path = side === "base" ? (file.prevName ?? file.name) : file.name;
  if (path === "/dev/null") return null;
  for (const hunk of file.hunks) {
    let cursor = side === "base" ? hunk.deletionStart : hunk.additionStart;
    for (const block of hunk.hunkContent) {
      const count =
        block.type === "context"
          ? block.lines
          : side === "base"
            ? block.deletions
            : block.additions;
      if (line >= cursor && line < cursor + count) {
        // Added lines are deliberately unsupported, including checkpoint/uncommitted additions.
        if (side === "head" && block.type === "change") return null;
        return { side, line, filePath: path };
      }
      cursor += count;
    }
  }
  return null;
}

/** Per-view, bounded memory cache. Dispose on source/connection invalidation; failures are retryable. */
export function createLineBlameReader(input: {
  environmentId: string;
  source: GitComparisonSource;
  read: (input: GitReadLineBlameInput) => Promise<GitReadLineBlameResult>;
}) {
  let disposed = false;
  let generation = 0;
  const cache = new Map<string, Promise<GitReadLineBlameResult>>();
  return {
    invalidate() {
      generation++;
      cache.clear();
    },
    dispose() {
      disposed = true;
      generation++;
      cache.clear();
    },
    read(target: LineBlameTarget): Promise<GitReadLineBlameResult> {
      if (disposed) return Promise.reject(new Error("Comparison changed. Reopen line blame."));
      const key = `${comparisonFileKey(input.environmentId, input.source, target.side, target.filePath)}:${target.line}`;
      const cached = cache.get(key);
      if (cached) return cached;
      const ticket = generation;
      const request = Promise.resolve()
        .then(() => {
          if (disposed || ticket !== generation)
            throw new Error("Comparison changed. Reopen line blame.");
          return input.read({
            cwd: input.source.worktreePath,
            oid: target.side === "base" ? input.source.baseOid : input.source.headOid,
            filePath: target.filePath,
            line: target.line,
          });
        })
        .then((result) => {
          if (disposed || ticket !== generation)
            throw new Error("Comparison changed. Reopen line blame.");
          return result;
        })
        .catch((error: unknown) => {
          if (cache.get(key) === request) cache.delete(key);
          throw error;
        });
      cache.set(key, request);
      if (cache.size > 32) cache.delete(cache.keys().next().value!);
      return request;
    },
  };
}
