/**
 * From the repository root (pinned Bun):
 *   bun apps/server/scripts/measure-thread-git-metadata.ts
 * Optional event count for the filter pass (default 1000000):
 *   bun apps/server/scripts/measure-thread-git-metadata.ts 200000
 *
 * Measures what the thread git metadata reactor costs per provider event, per
 * classified shell command (realistic and adversarial inputs, against the
 * backtracking regex its spec first proposed), and per HEAD read (against one
 * `git rev-parse` spawn, the cost the file read avoids). Only deterministic
 * counts are asserted; timings are informational. The forge-work bound over a
 * busy turn is asserted in `ThreadGitMetadataReactor.test.ts`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { ProviderRuntimeEvent } from "@ryco/contracts";
import { classifyVcsCommand } from "@ryco/shared/vcsCommand";
import { Effect } from "effect";

import { mayRequestThreadGitSync } from "../src/orchestration/Layers/ThreadGitMetadataReactor.ts";
import { gitSyncTriggerFor } from "../src/orchestration/threadGitMetadata.ts";
import { locateCheckoutHead } from "../src/orchestration/threadGitMetadataRuntime.ts";
import { readCheckoutHead } from "../src/vcs/gitCheckoutHead.ts";

const eventCount = Number(process.argv[2] ?? 1_000_000);
assert(
  Number.isSafeInteger(eventCount) && eventCount > 0,
  "event count must be a positive integer",
);

const percentile = (sorted: ReadonlyArray<number>, p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))]!;
const micros = (ms: number) => `${(ms * 1_000).toFixed(1)} µs`;

// 1. Per-event cost: the boot-path filter, then the runtime's trigger for what passes.
const base = {
  eventId: "evt",
  provider: "codex",
  threadId: "thread-1",
  createdAt: "2026-10-28T00:00:00.000Z",
};
const sampleEvents: ProviderRuntimeEvent[] = [];
for (let index = 0; index < 100; index += 1) {
  const event =
    index < 90
      ? { ...base, type: "content.delta", payload: { streamKind: "assistant_text", delta: "x" } }
      : index < 98
        ? { ...base, type: "item.updated", payload: { itemType: "command_execution" } }
        : index === 98
          ? {
              ...base,
              type: "item.completed",
              payload: {
                itemType: "command_execution",
                status: "completed",
                data: { item: { command: "git commit -m step && git push" } },
              },
            }
          : { ...base, type: "turn.completed", turnId: "turn-1", payload: { state: "completed" } };
  sampleEvents.push(event as unknown as ProviderRuntimeEvent);
}
let passed = 0;
let triggers = 0;
const filterPass = () => {
  for (let index = 0; index < eventCount; index += 1) {
    const event = sampleEvents[index % 100]!;
    if (!mayRequestThreadGitSync(event)) continue;
    passed += 1;
    if (gitSyncTriggerFor(event) !== null) triggers += 1;
  }
};
filterPass();
assert.equal(passed, Math.floor(eventCount / 100) * 2 + Math.max(0, (eventCount % 100) - 98));
const expectedTriggers = passed;
passed = 0;
triggers = 0;
const filterStartedAt = performance.now();
filterPass();
const filterMs = performance.now() - filterStartedAt;
assert.equal(triggers, expectedTriggers, "every event that passes the filter here is a trigger");

// 2. Command classification: realistic agent commands, then adversarial ones.
const realistic = [
  "git status",
  "git status --porcelain",
  "git diff",
  "git diff --stat HEAD~1",
  "git log --oneline -20",
  "git show HEAD",
  "git add -A",
  "git add src/app.ts && git commit -m 'fix: handle empty input'",
  "git commit -m \"$(cat <<'EOF'\nAdd the parser\n\nCo-Authored-By: Agent <a@example.test>\nEOF\n)\"",
  "git checkout -b feat/parser",
  "git switch main",
  "git switch -c fix/flaky-test",
  "git pull --rebase",
  "git push -u origin HEAD",
  "git push",
  "git fetch origin",
  "git rebase origin/main",
  "git stash && git pull && git stash pop",
  "git cherry-pick abc1234",
  "git reset --hard HEAD~1",
  "git worktree list",
  "git branch -a",
  "git rev-parse --abbrev-ref HEAD",
  "git -C packages/app status",
  "gh pr create --fill",
  "gh pr create --title 'Add parser' --body 'Adds the parser.'",
  "gh pr view --json number,url",
  "gh pr checks 12",
  "gh pr merge 12 --squash --delete-branch",
  "gh pr checkout 12",
  "gh api repos/org/app/pulls/12/comments",
  "glab mr create --fill",
  "glab mr view 3",
  "npm test",
  "bun run test -- src/app.test.ts",
  "bun run lint",
  "pnpm install",
  "ls -la",
  "cat package.json",
  "rg -n 'parseHead' apps/server/src",
  "sed -n '1,80p' src/app.ts",
  "cd apps/server && bun run typecheck",
  "python3 -m pytest -q",
  "make build",
  "docker compose up -d",
  "bash -lc 'git rebase main'",
  "FOO=1 git cherry-pick abc1234",
  "echo done",
  "mkdir -p tmp && touch tmp/x",
  "node scripts/generate.ts",
];
assert.equal(realistic.length, 50);
const classifiedCount = realistic.filter((command) => classifyVcsCommand(command) !== null).length;
assert.equal(classifiedCount, 22, "fixture classification count");
const rounds = 10_000;
for (const command of realistic) classifyVcsCommand(command);
const classifyStartedAt = performance.now();
for (let round = 0; round < rounds; round += 1) {
  for (const command of realistic) classifyVcsCommand(command);
}
const classifyMs = performance.now() - classifyStartedAt;

// The spec's first proposal: a global scan with a backtracking path prefix.
const SPEC_BOUNDARY = /(?:^|[\s;&|()`'"=])(?:\S*\/)?(git|gh|glab)(?:\.exe)?\s/g;
const specScan = (command: string) => {
  let matches = 0;
  for (const _ of command.slice(0, 16_384).matchAll(SPEC_BOUNDARY)) matches += 1;
  return matches;
};
const json = JSON.stringify(
  Object.fromEntries(Array.from({ length: 900 }, (_, index) => [`k${index}`, `v/${index}=a`])),
);
const adversarial: Array<[string, string]> = [
  ["curl -d '<minified JSON>'", `curl -d '${json}' https://example.test`.slice(0, 16_384)],
  ['"a=" x 8000', "a=".repeat(8_000)],
  ['"\\"a" x 8000', '"a'.repeat(8_000)],
  ["16 KB heredoc commit body", `git commit -F - <<'EOF'\n${"line of text\n".repeat(1_260)}EOF`],
];
const best = (run: () => void, attempts = 5) => {
  let fastest = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const startedAt = performance.now();
    run();
    fastest = Math.min(fastest, performance.now() - startedAt);
  }
  return fastest;
};
const adversarialRows = adversarial.map(([label, input]) => ({
  input: label,
  chars: input.length,
  classifyVcsCommand: `${best(() => classifyVcsCommand(input)).toFixed(3)} ms`,
  specRegex: `${best(() => specScan(input), 3).toFixed(3)} ms`,
}));

// 3. HEAD reads: main checkout, linked worktree, a subfolder project (walks up), one git spawn.
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ryco-measure-head-")));
const git = (cwd: string, args: ReadonlyArray<string>) =>
  execFileSync(
    "git",
    ["-c", "user.email=m@example.test", "-c", "user.name=M", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
  );
const headRows: Array<Record<string, string>> = [];
try {
  const repo = path.join(scratch, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["commit", "--allow-empty", "-m", "init"]);
  const worktree = path.join(scratch, "wt");
  git(repo, ["worktree", "add", "-b", "feat/measure", worktree]);
  const subfolder = path.join(repo, "packages", "app", "src");
  fs.mkdirSync(subfolder, { recursive: true });

  const timeReads = async (label: string, read: () => Promise<unknown>, expected: unknown) => {
    assert.deepEqual(await read(), expected);
    const samples: number[] = [];
    for (let index = 0; index < 2_000; index += 1) {
      const startedAt = performance.now();
      await read();
      samples.push(performance.now() - startedAt);
    }
    samples.sort((left, right) => left - right);
    headRows.push({
      read: label,
      p50: micros(percentile(samples, 50)),
      p95: micros(percentile(samples, 95)),
      p99: micros(percentile(samples, 99)),
    });
  };
  const branchOf = (cwd: string) =>
    Effect.runPromise(readCheckoutHead(cwd)).then((head) => head?.branch);
  await timeReads("readCheckoutHead, main checkout", () => branchOf(repo), "main");
  await timeReads("readCheckoutHead, linked worktree", () => branchOf(worktree), "feat/measure");
  await timeReads(
    "locateCheckoutHead, project 3 folders below the root",
    () =>
      Effect.runPromise(locateCheckoutHead(subfolder)).then((location) =>
        location._tag === "head" ? location.branch : location._tag,
      ),
    "main",
  );
  const spawnSamples: number[] = [];
  for (let index = 0; index < 50; index += 1) {
    const startedAt = performance.now();
    assert.equal(git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "feat/measure");
    spawnSamples.push(performance.now() - startedAt);
  }
  spawnSamples.sort((left, right) => left - right);
  headRows.push({
    read: "git rev-parse --abbrev-ref HEAD (spawn), 50 runs",
    p50: micros(percentile(spawnSamples, 50)),
    p95: micros(percentile(spawnSamples, 95)),
    p99: micros(percentile(spawnSamples, 99)),
  });
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log("Thread git metadata reactor; timings are informational.\n");
console.log(
  `1. ${eventCount.toLocaleString("en-US")} provider events (90% deltas, 8% item.updated, 1% command completions, 1% turn ends):`,
);
console.table([
  {
    passedFilter: passed,
    triggers,
    totalMs: filterMs.toFixed(1),
    perEvent: `${((filterMs * 1e6) / eventCount).toFixed(1)} ns`,
  },
]);
console.log(
  `2. classifyVcsCommand over ${realistic.length} realistic commands x ${rounds.toLocaleString("en-US")} (${classifiedCount} classify as git/forge changes):`,
);
console.table([
  {
    calls: realistic.length * rounds,
    totalMs: classifyMs.toFixed(1),
    perCommand: micros(classifyMs / (realistic.length * rounds)),
  },
]);
console.log("   Adversarial inputs, best of five (the spec's regex: best of three):");
console.table(adversarialRows);
console.log("3. HEAD reads, 2,000 each (the spawn: 50):");
console.table(headRows);
