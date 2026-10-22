// Persists the native artifact cache (scripts/lib/native-build-cache.ts and the
// desktop Cua cache) between release runs as GitHub run artifacts. Any run in this
// repository, including pull requests from forks, can upload an artifact with the
// same name, so only artifacts uploaded by a release.yml workflow_dispatch run on
// main are restored. Builds still verify every entry and compile from source when
// one does not match.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const RESTORE_MARKER = ".restore-marker";
const TRUSTED_WORKFLOW_PATH = ".github/workflows/release.yml";
const TRUSTED_EVENT = "workflow_dispatch";
const TRUSTED_BRANCH = "main";
// Bounds API calls when untrusted runs keep uploading artifacts under this name.
const MAX_RUN_LOOKUPS = 10;

export interface RunArtifact {
  readonly id: number;
  readonly name: string;
  readonly expired: boolean;
  readonly created_at: string | null;
  readonly expires_at: string | null;
  readonly workflow_run?: {
    readonly id?: number;
    readonly head_branch?: string | null;
    readonly repository_id?: number;
    readonly head_repository_id?: number;
  } | null;
}

export interface WorkflowRun {
  readonly id: number;
  readonly path: string;
  readonly event: string;
  readonly head_branch: string | null;
  readonly repository: { readonly full_name: string } | null;
  readonly head_repository: { readonly full_name: string } | null;
}

export type ArtifactChoice =
  | { readonly artifact: RunArtifact; readonly run: WorkflowRun }
  | {
      readonly artifact: null;
      readonly reason: string;
      /** Run whose metadata decides the next-newest candidate. */
      readonly pendingRunId?: number;
    };

/** Unexpired artifacts with this exact name, newest first. */
function liveArtifacts(artifacts: readonly RunArtifact[], name: string, now: Date): RunArtifact[] {
  return artifacts
    .filter(
      (artifact) =>
        artifact.name === name &&
        artifact.expired === false &&
        (artifact.expires_at === null || Date.parse(artifact.expires_at) > now.getTime()),
    )
    .toSorted(
      (left, right) =>
        Date.parse(right.created_at ?? "") - Date.parse(left.created_at ?? "") ||
        right.id - left.id,
    );
}

function untrustedRunReason(run: WorkflowRun, repository: string): string | null {
  if (run.path !== TRUSTED_WORKFLOW_PATH) return `workflow ${run.path}`;
  if (run.event !== TRUSTED_EVENT) return `event ${run.event}`;
  if (run.head_branch !== TRUSTED_BRANCH) return `branch ${run.head_branch}`;
  if (run.repository?.full_name !== repository) return `repository ${run.repository?.full_name}`;
  if (run.head_repository?.full_name !== repository)
    return `head repository ${run.head_repository?.full_name}`;
  return null;
}

/**
 * Pick the newest unexpired artifact uploaded by a trusted release run of this
 * repository. Returns pendingRunId when a newer candidate's run must be read first.
 */
export function chooseTrustedArtifact({
  artifacts,
  runs,
  name,
  repository,
  now,
}: {
  readonly artifacts: readonly RunArtifact[];
  readonly runs: ReadonlyMap<number, WorkflowRun>;
  readonly name: string;
  readonly repository: string;
  readonly now: Date;
}): ArtifactChoice {
  const candidates = liveArtifacts(artifacts, name, now);
  if (candidates.length === 0)
    return { artifact: null, reason: `no unexpired artifact named ${name}` };
  const rejections: string[] = [];
  const reject = (artifact: RunArtifact, reason: string) =>
    rejections.push(`artifact ${artifact.id} (run ${artifact.workflow_run?.id}): ${reason}`);
  for (const artifact of candidates) {
    const summary = artifact.workflow_run;
    if (summary?.id === undefined) {
      reject(artifact, "no workflow run");
      continue;
    }
    // The listing's run summary may only rule an artifact out (saving a run
    // lookup); trust always comes from the run record itself.
    if (summary.head_branch != null && summary.head_branch !== TRUSTED_BRANCH) {
      reject(artifact, `branch ${summary.head_branch}`);
      continue;
    }
    if (summary.head_repository_id !== summary.repository_id) {
      reject(artifact, "fork run");
      continue;
    }
    const run = runs.get(summary.id);
    if (run === undefined)
      return {
        artifact: null,
        reason: `run ${summary.id} not inspected; ${rejections.join("; ")}`,
        pendingRunId: summary.id,
      };
    const reason = run.id === summary.id ? untrustedRunReason(run, repository) : "run mismatch";
    if (reason === null) return { artifact, run };
    reject(artifact, reason);
  }
  return { artifact: null, reason: `no trusted ${name} artifact; ${rejections.join("; ")}` };
}

/** Move restored <group>/<key> entries into place, backdated so prune drops unused ones. */
function installEntries(staging: string, dest: string, restoredAt: Date): number {
  let installed = 0;
  for (const group of readdirSync(staging, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    for (const entry of readdirSync(join(staging, group.name), { withFileTypes: true })) {
      const target = join(dest, group.name, entry.name);
      // Keep entries that already exist locally; builds verify whichever they use.
      if (!entry.isDirectory() || existsSync(target)) continue;
      mkdirSync(join(dest, group.name), { recursive: true });
      renameSync(join(staging, group.name, entry.name), target);
      utimesSync(target, restoredAt, restoredAt);
      installed += 1;
    }
  }
  return installed;
}

export interface RestoreDependencies {
  readonly listArtifacts: (name: string) => Promise<readonly RunArtifact[]>;
  readonly getRun: (id: number) => Promise<WorkflowRun>;
  readonly download: (runId: number, name: string, directory: string) => void;
  readonly now: () => Date;
}

/** Restore the newest trusted artifact into dest; throws on any failure. */
export async function restoreNativeCache(
  {
    name,
    dest,
    repository,
  }: { readonly name: string; readonly dest: string; readonly repository: string },
  dependencies: RestoreDependencies,
): Promise<string> {
  const artifacts = await dependencies.listArtifacts(name);
  const runs = new Map<number, WorkflowRun>();
  const now = dependencies.now();
  let choice = chooseTrustedArtifact({ artifacts, runs, name, repository, now });
  while (
    choice.artifact === null &&
    choice.pendingRunId !== undefined &&
    runs.size < MAX_RUN_LOOKUPS
  ) {
    runs.set(choice.pendingRunId, await dependencies.getRun(choice.pendingRunId));
    choice = chooseTrustedArtifact({ artifacts, runs, name, repository, now });
  }
  if (choice.artifact === null)
    throw new Error(
      choice.pendingRunId === undefined
        ? choice.reason
        : `stopped after ${MAX_RUN_LOOKUPS} run lookups; ${choice.reason}`,
    );
  // Download beside dest so a partial download never leaves partial entries.
  mkdirSync(dirname(dest), { recursive: true });
  const staging = mkdtempSync(join(dirname(dest), ".native-cache-restore-"));
  try {
    const download = join(staging, "artifact");
    dependencies.download(choice.run.id, name, download);
    const createdAt = Date.parse(choice.artifact.created_at ?? "");
    const installed = installEntries(
      download,
      dest,
      new Date(Number.isNaN(createdAt) ? 0 : createdAt),
    );
    return `Restored ${installed} ${name} entries from release run ${choice.run.id} (artifact ${choice.artifact.id}, ${choice.artifact.created_at}).`;
  } finally {
    rmSync(staging, { recursive: true, force: true, maxRetries: 5 });
  }
}

/** Write the marker that prune compares entry mtimes against. */
export function writeRestoreMarker(dest: string, markedAt: Date): void {
  mkdirSync(dest, { recursive: true });
  const marker = join(dest, RESTORE_MARKER);
  writeFileSync(marker, `${markedAt.toISOString()}\n`);
  // Builds touch reused entries with millisecond Dates; match that precision.
  utimesSync(marker, markedAt, markedAt);
}

/** Remove <group>/<key> entries no build touched since the restore marker. */
export function pruneNativeCache(directory: string): string[] {
  const marker = join(directory, RESTORE_MARKER);
  const cutoff = statSync(marker).mtimeMs;
  const removed: string[] = [];
  for (const group of readdirSync(directory, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const groupPath = join(directory, group.name);
    for (const entry of readdirSync(groupPath, { withFileTypes: true })) {
      const entryPath = join(groupPath, entry.name);
      if (!entry.isDirectory() || statSync(entryPath).mtimeMs >= cutoff) continue;
      rmSync(entryPath, { recursive: true, force: true, maxRetries: 5 });
      removed.push(`${group.name}/${entry.name}`);
    }
    if (readdirSync(groupPath).length === 0) rmSync(groupPath, { recursive: true, force: true });
  }
  rmSync(marker, { force: true });
  return removed;
}

async function githubJson(path: string, token: string): Promise<unknown> {
  const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const response = await fetch(`${api}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "ryco-native-cache",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub API ${path} returned HTTP ${response.status}.`);
  return response.json();
}

function githubDependencies(repository: string, token: string): RestoreDependencies {
  return {
    async listArtifacts(name) {
      const body = await githubJson(
        `/repos/${repository}/actions/artifacts?per_page=100&name=${encodeURIComponent(name)}`,
        token,
      );
      if (
        typeof body !== "object" ||
        body === null ||
        !("artifacts" in body) ||
        !Array.isArray(body.artifacts)
      )
        throw new Error("GitHub returned an invalid artifact list.");
      return body.artifacts as RunArtifact[];
    },
    async getRun(id) {
      return (await githubJson(`/repos/${repository}/actions/runs/${id}`, token)) as WorkflowRun;
    },
    download(runId, name, directory) {
      const result = spawnSync(
        "gh",
        [
          "run",
          "download",
          String(runId),
          "--repo",
          repository,
          "--name",
          name,
          "--dir",
          directory,
        ],
        {
          env: { ...process.env, GH_TOKEN: token },
          stdio: ["ignore", "inherit", "inherit"],
          timeout: 10 * 60_000,
        },
      );
      if (result.error || result.status !== 0)
        throw new Error(
          `gh run download failed: ${result.error?.message ?? `exit ${result.status ?? result.signal}`}`,
        );
    },
    now: () => new Date(),
  };
}

function warn(message: string): void {
  // Workflow command data must escape %, CR, and LF.
  const escaped = message.replace(/%/gu, "%25").replace(/\r/gu, "%0D").replace(/\n/gu, "%0A");
  process.stdout.write(`::warning::${escaped}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const usage = `Usage:
  node scripts/ci/native-cache.ts restore --name <artifact-name> --dest <dir>
  node scripts/ci/native-cache.ts prune --dir <dir>`;

function parseCommandLine(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      name: { type: "string" },
      dest: { type: "string" },
      dir: { type: "string" },
    },
  });
}

export async function main(argv: readonly string[]): Promise<number> {
  let parsed: ReturnType<typeof parseCommandLine>;
  try {
    parsed = parseCommandLine(argv);
  } catch (error) {
    console.error(`${errorMessage(error)}\n${usage}`);
    return 2;
  }
  const { positionals, values } = parsed;
  const [command] = positionals;
  if (
    command === "restore" &&
    positionals.length === 1 &&
    values.name &&
    values.dest &&
    values.dir === undefined
  ) {
    // Artifact names never need more than this; it also keeps the API query plain.
    if (!/^[\w.-]+$/u.test(values.name)) {
      console.error(`Invalid artifact name: ${values.name}`);
      return 2;
    }
    const dest = resolve(values.dest);
    try {
      const repository = process.env.GITHUB_REPOSITORY ?? "";
      const token = process.env.GH_TOKEN ?? "";
      if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) throw new Error("GITHUB_REPOSITORY is not set.");
      if (!token) throw new Error("GH_TOKEN is not set.");
      console.log(
        `[native-cache] ${await restoreNativeCache(
          { name: values.name, dest, repository },
          githubDependencies(repository, token),
        )}`,
      );
    } catch (error) {
      warn(`Native cache not restored; building from source. ${errorMessage(error)}`);
    }
    try {
      writeRestoreMarker(dest, new Date());
    } catch (error) {
      warn(`Could not write the native cache restore marker. ${errorMessage(error)}`);
    }
    return 0;
  }
  if (
    command === "prune" &&
    positionals.length === 1 &&
    values.dir &&
    values.name === undefined &&
    values.dest === undefined
  ) {
    const directory = resolve(values.dir);
    try {
      if (!existsSync(join(directory, RESTORE_MARKER))) {
        warn(`No ${RESTORE_MARKER} in ${directory}; native cache left unpruned.`);
        return 0;
      }
      const removed = pruneNativeCache(directory);
      console.log(
        `[native-cache] Pruned ${removed.length} unused entries${removed.length > 0 ? `: ${removed.join(", ")}` : "."}`,
      );
    } catch (error) {
      warn(`Native cache prune failed. ${errorMessage(error)}`);
    }
    return 0;
  }
  console.error(usage);
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
