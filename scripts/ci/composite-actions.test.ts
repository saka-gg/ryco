import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const actionsDir = join(import.meta.dirname, "../../.github/actions");

/** Lines of every `description:` block (inline or folded) in an action manifest. */
function descriptionLines(manifest: string): string[] {
  const lines = manifest.split("\n");
  const found: string[] = [];
  let indent = -1;
  for (const line of lines) {
    const start = /^(\s*)description:(.*)$/u.exec(line);
    if (start) {
      indent = start[1]!.length;
      found.push(start[2]!);
      continue;
    }
    if (indent < 0) continue;
    if (line.trim() && /^\s*/u.exec(line)![0].length <= indent) indent = -1;
    else found.push(line);
  }
  return found;
}

describe("composite actions", () => {
  // The runner evaluates expressions even inside description text when it loads
  // an action, so an example like `if: ${{ !cancelled() }}` fails every job that
  // uses the action with "Unrecognized function". actionlint does not lint
  // composite actions, so nothing else catches it before CI.
  it.each(readdirSync(actionsDir))("%s has no expressions in its descriptions", (name) => {
    const manifest = readFileSync(join(actionsDir, name, "action.yml"), "utf8");
    expect(descriptionLines(manifest).filter((line) => line.includes("${{"))).toEqual([]);
  });
});
