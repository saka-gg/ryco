import { describe, expect, it } from "vite-plus/test";

import {
  MAX_SCANNED_COMMAND_CHARS,
  classifyVcsCommand,
  mergeVcsCommandEffects,
  type VcsCommandEffect,
} from "./vcsCommand.ts";

const L: VcsCommandEffect = { local: true, remote: false };
const R: VcsCommandEffect = { local: false, remote: true };
const LR: VcsCommandEffect = { local: true, remote: true };

describe("classifyVcsCommand", () => {
  it.each<[string, VcsCommandEffect | null]>([
    ["git checkout -b feat/x", L],
    ["git switch main", L],
    ['git commit -m "fix"', L],
    ["git add -A && git commit -m x && git push -u origin HEAD", LR],
    ["cd repo && git -C sub push", R],
    ['git -C "my repo" push', R],
    ["bash -lc 'git rebase main'", L],
    ["sh -c \"bash -lc 'git stash pop'\"", L],
    ["/usr/bin/git commit", L],
    ["git.exe reset --hard", L],
    ["git --no-pager -c core.x=y fetch", R],
    ["git --git-dir=.git --work-tree . pull --rebase", LR],
    ["FOO=1 git cherry-pick abc123", L],
    ["x=$(git push origin HEAD 2>&1) || true", R],
    ["echo `git worktree add ../x`", L],
    ["git push\\\n  origin main", R],
    ["git push>/dev/null 2>&1", R],
    ["git commit -m x 2>/dev/null </dev/null", L],
    ["git log>git-push.txt", null],
    ["gh pr create --fill", R],
    ["gh pr merge 12 --squash", R],
    ["gh --repo org/app pr ready 12", R],
    ["gh pr view 12", null],
    ["gh pr status", null],
    ["gh pr checks 12", null],
    ["gh pr checkout 12", LR],
    ["gh api repos/org/app/pulls", null],
    ["glab mr create", R],
    ["glab mr view 3", null],
    ["glab mr checkout 3", LR],
    ["git status", null],
    ["git log --oneline", null],
    ["git diff HEAD~1", null],
    ["git rev-parse --abbrev-ref HEAD", null],
    ["git", null],
    ["npm test", null],
    ["legit pushover", null],
    ["digit commit", null],
    ["cd git && make", null],
    ["", null],
  ])("%s", (command, expected) => {
    expect(classifyVcsCommand(command)).toEqual(expected);
  });

  it("over-matches a commit body that mentions a push (accepted: a status re-read is cheap)", () => {
    const command = [
      "git commit -F - <<'EOF'",
      "Document the release",
      "",
      "Run git push after tagging.",
      "EOF",
    ].join("\n");
    expect(classifyVcsCommand(command)).toEqual(LR);
  });

  it("scans no further than MAX_SCANNED_COMMAND_CHARS", () => {
    const padding = "x".repeat(MAX_SCANNED_COMMAND_CHARS + 3_616);
    expect(classifyVcsCommand(`echo ${padding} && git push`)).toBeNull();
    expect(classifyVcsCommand(`git push && echo ${padding}`)).toEqual(R);
  });

  it("stays linear on inputs that make a backtracking scan quadratic", () => {
    const json = JSON.stringify(
      Object.fromEntries(Array.from({ length: 900 }, (_, index) => [`k${index}`, `v/${index}=a`])),
    );
    const inputs = [
      `curl -d '${json}' https://example.test`,
      "a=".repeat(8_000),
      '"a'.repeat(8_000),
      "'a".repeat(8_000),
      "/".repeat(16_000),
      `${"\\".repeat(8_000)}git push`,
    ];
    for (const input of inputs) {
      let best = Number.POSITIVE_INFINITY;
      // Best of five: the budget catches quadratic growth (tens of ms per call),
      // not scheduler noise on a busy machine.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const startedAt = performance.now();
        classifyVcsCommand(input);
        best = Math.min(best, performance.now() - startedAt);
      }
      expect(best, input.slice(0, 40)).toBeLessThan(5);
    }
  });
});

describe("mergeVcsCommandEffects", () => {
  it("ORs both flags and keeps null as the identity", () => {
    expect(mergeVcsCommandEffects(null, null)).toBeNull();
    expect(mergeVcsCommandEffects(L, null)).toEqual(L);
    expect(mergeVcsCommandEffects(null, R)).toEqual(R);
    expect(mergeVcsCommandEffects(L, R)).toEqual(LR);
    expect(mergeVcsCommandEffects(L, L)).toEqual(L);
  });
});
