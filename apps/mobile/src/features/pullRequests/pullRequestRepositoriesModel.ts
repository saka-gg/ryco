import type { EnvironmentId, ProjectId, RepositoryIdentity } from "@ryco/contracts";
import { isChatProject, type ProjectKindCarrier } from "@ryco/shared/projectKind";

/**
 * The PRs tab's repository picker: one choice per repository (its remote's
 * canonical key), however many checkouts of it the reader's machines have.
 * Each choice reads through one representative checkout, preferring a node
 * that is connected now, then the repository's own root over a worktree.
 */

export interface PullRequestRepositoryProject extends ProjectKindCarrier {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly cwd: string;
  readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
}

export interface PullRequestRepositoryChoice {
  /** The remote's canonical key (`github.com/acme/app`). */
  readonly key: string;
  /** `acme/app`, else the remote's display name, else the project name. */
  readonly label: string;
  /** `github`, `gitlab`, …; null when the remote does not say. */
  readonly provider: string | null;
  /** The checkout the list and details read through. */
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly cwd: string;
  /** The machine that checkout is on, for the picker's subtitle. */
  readonly environmentLabel: string | null;
  /** Checkouts of this repository across every machine. */
  readonly checkouts: number;
  /** Whether the representative checkout's machine is connected now. */
  readonly connected: boolean;
}

function repositoryLabel(project: PullRequestRepositoryProject): string {
  const identity = project.repositoryIdentity;
  if (identity?.owner && identity.name) return `${identity.owner}/${identity.name}`;
  return identity?.displayName ?? project.name;
}

function isRepositoryRoot(project: PullRequestRepositoryProject): boolean {
  const root = project.repositoryIdentity?.rootPath;
  return root !== undefined && root === project.cwd;
}

/** Negative when `left` is the better checkout to read through. */
function compareCheckouts(
  left: PullRequestRepositoryProject,
  right: PullRequestRepositoryProject,
  connected: ReadonlySet<EnvironmentId>,
): number {
  const leftConnected = connected.has(left.environmentId) ? 0 : 1;
  const rightConnected = connected.has(right.environmentId) ? 0 : 1;
  if (leftConnected !== rightConnected) return leftConnected - rightConnected;
  const leftRoot = isRepositoryRoot(left) ? 0 : 1;
  const rightRoot = isRepositoryRoot(right) ? 0 : 1;
  if (leftRoot !== rightRoot) return leftRoot - rightRoot;
  return (
    left.cwd.length - right.cwd.length ||
    left.environmentId.localeCompare(right.environmentId) ||
    left.cwd.localeCompare(right.cwd)
  );
}

export function derivePullRequestRepositoryChoices(input: {
  readonly projects: ReadonlyArray<PullRequestRepositoryProject>;
  readonly connected: ReadonlySet<EnvironmentId>;
  readonly environmentLabels: ReadonlyMap<EnvironmentId, string>;
}): ReadonlyArray<PullRequestRepositoryChoice> {
  const byKey = new Map<string, PullRequestRepositoryProject[]>();
  for (const project of input.projects) {
    const key = project.repositoryIdentity?.canonicalKey;
    // Chats have no repository; a folder without a remote has no pull requests.
    if (key === undefined || isChatProject(project)) continue;
    const checkouts = byKey.get(key) ?? [];
    checkouts.push(project);
    byKey.set(key, checkouts);
  }
  const choices: PullRequestRepositoryChoice[] = [];
  for (const [key, checkouts] of byKey) {
    const best = checkouts.toSorted((left, right) =>
      compareCheckouts(left, right, input.connected),
    )[0];
    if (best === undefined) continue;
    choices.push({
      key,
      label: repositoryLabel(best),
      provider: best.repositoryIdentity?.provider ?? null,
      environmentId: best.environmentId,
      projectId: best.id,
      cwd: best.cwd,
      environmentLabel: input.environmentLabels.get(best.environmentId) ?? null,
      checkouts: checkouts.length,
      connected: input.connected.has(best.environmentId),
    });
  }
  return choices.toSorted(
    (left, right) =>
      left.label.localeCompare(right.label, undefined, { sensitivity: "base" }) ||
      left.key.localeCompare(right.key),
  );
}

/**
 * The choice to show: the one the reader picked last while it still exists,
 * else the first connected repository, else the first one.
 */
export function resolvePullRequestRepositoryChoice(
  choices: ReadonlyArray<PullRequestRepositoryChoice>,
  savedKey: string | null,
): PullRequestRepositoryChoice | null {
  if (savedKey !== null) {
    const saved = choices.find((choice) => choice.key === savedKey);
    if (saved) return saved;
  }
  return choices.find((choice) => choice.connected) ?? choices[0] ?? null;
}
