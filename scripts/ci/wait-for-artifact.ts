// Waits until another job of the same workflow run has uploaded an artifact.
// Release build legs start with their own setup instead of `needs:` on the job
// that produces the shared JS bundle, then call this right before they need it,
// so the two overlap. Fails as soon as the producing job finishes without the
// artifact (failed, cancelled, or skipped) instead of waiting out the timeout.
// Node builtins only: it runs before or without the workspace install.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export interface ArtifactList {
  readonly total_count: number;
}

export interface JobList {
  readonly jobs: ReadonlyArray<{
    readonly name: string;
    readonly status: string;
    readonly conclusion: string | null;
  }>;
}

export interface WaitDependencies {
  readonly artifactCount: (name: string) => Promise<number>;
  readonly jobs: () => Promise<JobList["jobs"]>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly now: () => number;
  readonly log: (message: string) => void;
}

export interface WaitOptions {
  readonly artifact: string;
  readonly job: string;
  readonly timeoutMs: number;
  readonly intervalMs: number;
}

/** Why the producing job can no longer upload the artifact, or null while it still can. */
export function producerFailure(jobs: JobList["jobs"], job: string): string | null {
  // A reusable or matrix job may report under a prefixed name ("Release / Build JS bundle").
  const matches = jobs.filter((entry) => entry.name === job || entry.name.endsWith(` / ${job}`));
  if (matches.length === 0) return null;
  for (const entry of matches) {
    if (entry.status !== "completed") return null;
  }
  const failed = matches.find((entry) => entry.conclusion !== "success");
  return failed
    ? `job "${failed.name}" finished with ${failed.conclusion ?? "no conclusion"}`
    : null;
}

/** Resolves once the artifact exists; throws when its job ends without it or on timeout. */
export async function waitForArtifact(
  options: WaitOptions,
  dependencies: WaitDependencies,
): Promise<void> {
  const deadline = dependencies.now() + options.timeoutMs;
  let polls = 0;
  for (;;) {
    if ((await dependencies.artifactCount(options.artifact)) > 0) {
      dependencies.log(`Artifact ${options.artifact} is available.`);
      return;
    }
    // Checked after the artifact lookup: a job that succeeded has uploaded it,
    // so a success here with no artifact yet only means the listing lags.
    const failure = producerFailure(await dependencies.jobs(), options.job);
    if (failure !== null) {
      // One more look: the upload may have landed between the two requests.
      if ((await dependencies.artifactCount(options.artifact)) > 0) return;
      throw new Error(`Artifact ${options.artifact} will not arrive: ${failure}.`);
    }
    if (dependencies.now() >= deadline)
      throw new Error(
        `Timed out after ${Math.round(options.timeoutMs / 1000)}s waiting for ${options.artifact}.`,
      );
    if (polls % 6 === 0)
      dependencies.log(`Waiting for ${options.artifact} from "${options.job}"...`);
    polls += 1;
    await dependencies.sleep(options.intervalMs);
  }
}

async function githubJson(path: string, token: string): Promise<unknown> {
  const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const response = await fetch(`${api}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "ryco-wait-for-artifact",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub API ${path} returned HTTP ${response.status}.`);
  return response.json();
}

/** A failed request counts as "not yet": transient API errors must not fail the wait. */
async function tolerantly<T>(
  request: () => Promise<T>,
  fallback: T,
  log: (message: string) => void,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    log(`::warning::${error instanceof Error ? error.message : String(error)}`);
    return fallback;
  }
}

function githubDependencies(repository: string, runId: string, token: string): WaitDependencies {
  const log = (message: string) => console.log(message);
  const run = `/repos/${repository}/actions/runs/${runId}`;
  return {
    artifactCount: (name) =>
      tolerantly(
        async () => {
          const body = (await githubJson(
            `${run}/artifacts?name=${encodeURIComponent(name)}`,
            token,
          )) as Partial<ArtifactList> | null;
          if (typeof body?.total_count !== "number")
            throw new Error("GitHub returned an invalid artifact list.");
          return body.total_count;
        },
        0,
        log,
      ),
    jobs: () =>
      tolerantly(
        async () => {
          const body = (await githubJson(
            `${run}/jobs?filter=latest&per_page=100`,
            token,
          )) as Partial<JobList> | null;
          if (!Array.isArray(body?.jobs)) throw new Error("GitHub returned an invalid job list.");
          return body.jobs;
        },
        [],
        log,
      ),
    sleep: (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
    now: () => Date.now(),
    log,
  };
}

const usage =
  "Usage: node scripts/ci/wait-for-artifact.ts --artifact <name> --job <job name> [--timeout-minutes 20]";

export async function main(argv: readonly string[]): Promise<number> {
  let values: { artifact?: string; job?: string; "timeout-minutes"?: string };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        artifact: { type: "string" },
        job: { type: "string" },
        "timeout-minutes": { type: "string" },
      },
    }));
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n${usage}`);
    return 2;
  }
  const timeoutMinutes = Number(values["timeout-minutes"] ?? "20");
  if (
    !values.artifact ||
    !/^[\w.-]+$/u.test(values.artifact) ||
    !values.job ||
    !Number.isFinite(timeoutMinutes) ||
    timeoutMinutes <= 0
  ) {
    console.error(usage);
    return 2;
  }
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const runId = process.env.GITHUB_RUN_ID ?? "";
  const token = process.env.GH_TOKEN ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository) || !/^\d+$/u.test(runId) || !token) {
    console.error("GITHUB_REPOSITORY, GITHUB_RUN_ID, and GH_TOKEN must be set.");
    return 2;
  }
  try {
    await waitForArtifact(
      {
        artifact: values.artifact,
        job: values.job,
        timeoutMs: timeoutMinutes * 60_000,
        intervalMs: 5_000,
      },
      githubDependencies(repository, runId, token),
    );
    return 0;
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
