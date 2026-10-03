import { describe, expect, it } from "vitest";

import {
  FIXTURE_688_FAILING_JOB,
  FIXTURE_703_FAILING_JOB,
  fixtureDetail,
  fixtureWorkflowJobLog,
  fixtureWorkflowRunJobs,
} from "../testing/pullRequestFixtures";
import {
  createJobLogPathResolver,
  jobLogAllLines,
  jobLogStepLines,
  jobLogTail,
  jobLogTailText,
  linkifyJobLogLine,
  splitJobLog,
} from "./jobLog";

const RAW = [
  "2026-10-03T09:00:00.0000000Z ##[group]Runner Image",
  "2026-10-03T09:00:00.1000000Z Image: ubuntu-24.04",
  "2026-10-03T09:00:00.2000000Z ##[endgroup]",
  "2026-10-03T09:00:01.0000000Z ##[group]Run bun install",
  "2026-10-03T09:00:01.1000000Z bun install",
  "2026-10-03T09:00:01.2000000Z shell: /usr/bin/bash -e {0}",
  "2026-10-03T09:00:01.3000000Z ##[endgroup]",
  "2026-10-03T09:00:02.0000000Z \u001b[32mdone\u001b[0m in 1.2s",
  "2026-10-03T09:00:03.0000000Z ##[group]Run bun run test",
  "2026-10-03T09:00:03.1000000Z bun run test",
  "2026-10-03T09:00:03.2000000Z ##[endgroup]",
  "2026-10-03T09:00:04.0000000Z $ vitest run",
  "2026-10-03T09:00:05.0000000Z  FAIL  src/a.test.ts > adds",
  "2026-10-03T09:00:06.0000000Z ##[error]Process completed with exit code 1.",
  "2026-10-03T09:00:07.0000000Z Post job cleanup.",
  "2026-10-03T09:00:07.1000000Z [command]/usr/bin/git version",
].join("\n");

describe("splitJobLog", () => {
  it("cuts the log at step groups and drops each step's echoed header", () => {
    const sections = splitJobLog(RAW);
    expect(sections.map((section) => section.title)).toEqual([
      null,
      "Run bun install",
      "Run bun run test",
      null,
    ]);
    expect(sections[0]?.lines.map((line) => line.text)).toEqual(["Image: ubuntu-24.04"]);
    expect(sections[1]?.lines.map((line) => line.text)).toEqual(["done in 1.2s"]);
    expect(sections[2]?.lines).toEqual([
      { text: "$ vitest run", tone: "command" },
      { text: " FAIL  src/a.test.ts > adds", tone: "error" },
      { text: "Error: Process completed with exit code 1.", tone: "error" },
    ]);
    expect(sections[2]?.failed).toBe(true);
    expect(sections[3]?.lines.map((line) => line.text)).toEqual([
      "Post job cleanup.",
      "[command]/usr/bin/git version",
    ]);
  });
});

describe("jobLogStepLines", () => {
  const sections = splitJobLog(RAW);

  it("finds a step by the command the runner announced", () => {
    expect(
      jobLogStepLines(sections, { name: "Run bun install" }, { failing: false })?.map(
        (line) => line.text,
      ),
    ).toEqual(["done in 1.2s"]);
    expect(jobLogStepLines(sections, { name: "Checkout" }, { failing: false })).toBeNull();
  });

  it("falls back to the failed section for a failing step and ends at its last error", () => {
    const lines = jobLogStepLines(sections, { name: "Unit tests" }, { failing: true });
    expect(lines?.at(-1)?.text).toBe("Error: Process completed with exit code 1.");
    expect(lines?.some((line) => line.text.startsWith("Post job"))).toBe(false);
  });

  it("reads the fixture logs for both failing jobs", () => {
    const web = splitJobLog(
      fixtureWorkflowJobLog(FIXTURE_703_FAILING_JOB.runId, FIXTURE_703_FAILING_JOB.jobId).log,
    );
    const webLines = jobLogStepLines(
      web,
      { name: "bun run test --filter=@ryco/web" },
      { failing: true },
    );
    expect(webLines?.[0]?.text).toBe("$ bun run test --filter=@ryco/web");
    expect(webLines?.at(-1)?.text).toBe("Error: Process completed with exit code 1.");

    const desktop = splitJobLog(
      fixtureWorkflowJobLog(FIXTURE_688_FAILING_JOB.runId, FIXTURE_688_FAILING_JOB.jobId).log,
    );
    expect(
      jobLogStepLines(desktop, { name: "Notarize (dry run)" }, { failing: true })?.some((line) =>
        line.text.includes("No Keychain password item found"),
      ),
    ).toBe(true);
  });

  it("matches steps whose names differ from their command by position", () => {
    const job = fixtureWorkflowRunJobs(FIXTURE_703_FAILING_JOB.runId).jobs.find(
      (candidate) => candidate.jobId === FIXTURE_703_FAILING_JOB.jobId,
    )!;
    const web = splitJobLog(
      fixtureWorkflowJobLog(FIXTURE_703_FAILING_JOB.runId, FIXTURE_703_FAILING_JOB.jobId).log,
    );
    const lines = (name: string) =>
      jobLogStepLines(web, { name }, { failing: false, steps: job.steps })?.map(
        (line) => line.text,
      ) ?? null;
    // "Setup Bun 1.3.2" printed as "Run oven-sh/setup-bun@v2" (its section is empty here).
    expect(lines("Setup Bun 1.3.2")).toEqual([]);
    expect(lines("bun run test --filter=@ryco/web")?.[0]).toBe("$ bun run test --filter=@ryco/web");
    expect(lines("Set up job")).toEqual(["Image: ubuntu-24.04", "Version: 20260928.1"]);
    // Without the step list, a renamed step has no section.
    expect(jobLogStepLines(web, { name: "Setup Bun 1.3.2" }, { failing: false })).toBeNull();
  });

  it("flattens every section for the full log and tails plain text", () => {
    const all = jobLogAllLines(sections);
    expect(all[1]).toEqual({ text: "Run bun install", tone: "command" });
    expect(jobLogTailText(all, 2)).toBe("Post job cleanup.\n[command]/usr/bin/git version");
  });

  it("tails long logs and numbers the first shown line", () => {
    const many = Array.from({ length: 250 }, (_, index) => ({
      text: `line ${index + 1}`,
      tone: "plain" as const,
    }));
    const tail = jobLogTail(many);
    expect(tail.lines).toHaveLength(200);
    expect(tail.firstLineNumber).toBe(51);
    expect(tail.lines[0]?.text).toBe("line 51");
    expect(jobLogTail(many.slice(0, 3))).toEqual({ lines: many.slice(0, 3), firstLineNumber: 1 });
  });
});

describe("log links", () => {
  const files = fixtureDetail(703).files!.map((file) => file.path);
  const resolve = createJobLogPathResolver(files);

  it("resolves relative, absolute and exact paths against changed files", () => {
    expect(resolve("src/components/pullRequests/stackLayers.logic.test.ts")).toBe(
      FIXTURE_703_FAILING_JOB.path,
    );
    expect(
      resolve(
        "/home/runner/work/ryco/ryco/apps/web/src/components/pullRequests/stackLayers.logic.test.ts",
      ),
    ).toBe(FIXTURE_703_FAILING_JOB.path);
    expect(resolve(FIXTURE_703_FAILING_JOB.path)).toBe(FIXTURE_703_FAILING_JOB.path);
    expect(resolve("src/not/in/the/diff.ts")).toBeNull();
  });

  it("refuses an ambiguous relative suffix", () => {
    const ambiguous = createJobLogPathResolver([
      "apps/web/src/index.ts",
      "apps/server/src/index.ts",
    ]);
    expect(ambiguous("src/index.ts")).toBeNull();
    expect(ambiguous("web/src/index.ts")).toBe("apps/web/src/index.ts");
  });

  it("links path:line[:col] and workflow-command files, leaving the rest as text", () => {
    expect(
      linkifyJobLogLine(" ❯ src/components/pullRequests/stackLayers.logic.test.ts:40:43", resolve),
    ).toEqual([
      { kind: "text", text: " ❯ " },
      {
        kind: "link",
        text: "src/components/pullRequests/stackLayers.logic.test.ts:40:43",
        path: FIXTURE_703_FAILING_JOB.path,
        line: 40,
      },
    ]);

    const command =
      "::error file=/home/runner/work/ryco/ryco/apps/web/src/components/pullRequests/stackLayers.logic.test.ts,title=src/x > fails,line=40,column=43::AssertionError";
    const segments = linkifyJobLogLine(command, resolve);
    const link = segments.find((segment) => segment.kind === "link");
    expect(link).toMatchObject({ path: FIXTURE_703_FAILING_JOB.path, line: 40 });
    expect(segments.map((segment) => segment.text).join("")).toBe(command);

    expect(linkifyJobLogLine("see docs/unknown.md:3 and v3.2.4", resolve)).toEqual([
      { kind: "text", text: "see docs/unknown.md:3 and v3.2.4" },
    ]);
    expect(linkifyJobLogLine("Duration 58.21s at 10:42:01", resolve)).toEqual([
      { kind: "text", text: "Duration 58.21s at 10:42:01" },
    ]);
  });
});
