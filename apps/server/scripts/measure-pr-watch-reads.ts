/**
 * Host reads of the server's pull request watch over one simulated hour, by kind.
 * node apps/server/scripts/measure-pr-watch-reads.ts
 *
 * Runs the real watch (sweep, read planner, decisions, orchestration engine on in-memory
 * SQLite) against a scripted host on a virtual clock: a watch started at minute 0, a sweep every
 * 2 minutes until minute 60, every wake taken by the provider at once. Counts provider calls
 * (fingerprint, detail, activity, review-thread tail) and prints them beside a naive baseline that
 * reads the detail and the activity every 60 seconds per watching thread (Synara's Auto-fix poll).
 *
 * These are simulated provider calls, not GitHub points: one GitHub detail read is about 4 `gh`
 * calls (pr view, stack, merge capabilities, required checks), one activity read at least 2
 * (target plus one page, up to 11 on a long conversation) and one review-thread tail 2 (target
 * plus the thread); the "gh (est.)" column applies those multipliers. Prints a Markdown table.
 */
import { PULL_REQUEST_WATCH_LIMITS } from "@ryco/shared/pullRequestWatch";

import {
  addPullRequest,
  createPullRequestWatchHarness,
  fakeForge,
  forgeComment,
  type FakePullRequest,
  type ForgeReadKind,
  type PullRequestWatchHarness,
} from "../src/sourceControl/pullRequestWatch.fixtures.ts";

const MINUTE = 60_000;
const HOUR_MINUTES = 60;
const GH_PER_CALL: Record<ForgeReadKind, number> = {
  fingerprint: 1,
  detail: 4,
  activity: 2,
  reviewThread: 2,
  changeRequest: 1,
  pullRequestState: 1,
};

interface Scenario {
  readonly name: string;
  readonly threads: number;
  readonly fingerprints: boolean;
  /** Moves the scripted pull request at a minute of the hour. */
  readonly script: (pr: FakePullRequest, minute: number, startMs: number) => void;
  readonly initialChecks: FakePullRequest["checks"];
}

const passed = [
  { name: "lint", conclusion: "SUCCESS" },
  { name: "test", conclusion: "SUCCESS" },
  { name: "build", conclusion: "SUCCESS" },
];

const scenarios: ReadonlyArray<Scenario> = [
  {
    name: "(a) quiet open PR",
    threads: 1,
    fingerprints: true,
    initialChecks: passed,
    script: () => undefined,
  },
  {
    name: "(b) CI runs 20 min, then fails",
    threads: 1,
    fingerprints: true,
    initialChecks: [{ name: "lint" }, { name: "test" }, { name: "build" }],
    script: (pr, minute) => {
      if (minute === 20) {
        pr.checks = [
          { name: "lint", conclusion: "SUCCESS" },
          { name: "test", conclusion: "FAILURE" },
          { name: "build", conclusion: "SUCCESS" },
        ];
      }
    },
  },
  {
    name: "(c) 3 review comments at minute 30",
    threads: 1,
    fingerprints: true,
    initialChecks: passed,
    script: (pr, minute, startMs) => {
      if (minute === 30) {
        const at = new Date(startMs + 30 * MINUTE).toISOString();
        pr.timeline = [1, 2, 3].map((index) =>
          forgeComment(`review-comment-${index}`, at, { body: `Point ${index}.` }),
        );
      }
    },
  },
  {
    name: "(d) 3 threads on one quiet PR",
    threads: 3,
    fingerprints: true,
    initialChecks: passed,
    script: () => undefined,
  },
  {
    name: "(e) quiet PR, host without a fingerprint",
    threads: 1,
    fingerprints: false,
    initialChecks: passed,
    script: () => undefined,
  },
];

async function measure(scenario: Scenario) {
  const forge = fakeForge();
  forge.fingerprints = scenario.fingerprints;
  const h: PullRequestWatchHarness = await createPullRequestWatchHarness({ forge });
  try {
    const startMs = h.clock.now();
    const pr = addPullRequest(forge, 12, { checks: scenario.initialChecks });
    const { projectId, worktreePath, threadId } = await h.seedWatchedSetup("measure", pr);
    const threads = [threadId];
    for (let index = 1; index < scenario.threads; index += 1) {
      threads.push(await h.seedThread({ key: `measure-${index}`, projectId, worktreePath }));
    }
    for (const thread of threads) {
      await h.run(h.watch.setWatch({ threadId: thread, origin: "user", news: true }));
    }
    for (let minute = 2; minute <= HOUR_MINUTES; minute += 2) {
      scenario.script(pr, minute - 1, startMs);
      scenario.script(pr, minute, startMs);
      h.clock.set(startMs + minute * MINUTE);
      await h.run(h.watch.sweep);
      // The provider takes every wake at once.
      for (const thread of threads) await h.bindPendingStarts(thread);
    }
    let wakes = 0;
    for (const thread of threads) wakes += (await h.wakes(thread)).length;
    return { calls: { ...forge.calls }, wakes };
  } finally {
    await h.dispose();
  }
}

const rows: string[] = [
  "| Scenario | fingerprint | detail | activity | thread tail | provider calls | gh (est.) | wakes | baseline calls | baseline gh (est.) | fewer gh calls |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
];
for (const scenario of scenarios) {
  const { calls, wakes } = await measure(scenario);
  const kinds: ForgeReadKind[] = ["fingerprint", "detail", "activity", "reviewThread"];
  const total = kinds.reduce((sum, kind) => sum + calls[kind], 0);
  const gh = kinds.reduce((sum, kind) => sum + calls[kind] * GH_PER_CALL[kind], 0);
  // Synara-style: every watching thread reads the detail and the activity every 60 s.
  const baselineCalls = scenario.threads * HOUR_MINUTES * 2;
  const baselineGh = scenario.threads * HOUR_MINUTES * (GH_PER_CALL.detail + GH_PER_CALL.activity);
  const saving = `${Math.round((1 - gh / baselineGh) * 100)} %`;
  rows.push(
    `| ${scenario.name} | ${calls.fingerprint} | ${calls.detail} | ${calls.activity} | ${calls.reviewThread} | ${total} | ${gh} | ${wakes} | ${baselineCalls} | ${baselineGh} | ${saving} |`,
  );
}
console.log(
  `Pull request watch, one simulated hour (sweep every ${PULL_REQUEST_WATCH_LIMITS.sweepIntervalMs / MINUTE} min; the watch's start read included):\n`,
);
console.log(rows.join("\n"));
