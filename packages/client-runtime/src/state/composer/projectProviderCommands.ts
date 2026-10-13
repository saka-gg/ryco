import type {
  EnvironmentApi,
  ProviderInstanceId,
  ProviderProjectCommands,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@ryco/contracts";

/** A directory's commands are read again (behind the reader) after this long. */
export const PROJECT_PROVIDER_COMMANDS_FRESH_MS = 5 * 60_000;
/** A failed read is retried at most this often. */
const RETRY_AFTER_FAILURE_MS = 30_000;
const CAPACITY = 64;

interface Entry {
  data: ProviderProjectCommands | undefined;
  readAtMs: number | undefined;
  failedAtMs: number | undefined;
  inFlight: boolean;
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

export function projectProviderCommandsKey(input: {
  readonly environmentId: string;
  readonly instanceId: string;
  readonly cwd: string;
}): string {
  return `${input.environmentId}\u0000${input.instanceId}\u0000${input.cwd}`;
}

/** The commands read for a key, if any (possibly stale). */
export function readProjectProviderCommands(key: string): ProviderProjectCommands | undefined {
  return entries.get(key)?.data;
}

export function subscribeProjectProviderCommands(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Reads the skills and slash commands an instance offers in a directory (project and local
 * ones the instance's snapshot cannot carry), once per key and freshness window. Called on the
 * composer's first `/` or `$` in a directory; a stale entry keeps serving while it is re-read.
 * A no-op unless the node advertises `providerProjectCommands` and the transport has the
 * method. Never throws.
 */
export function ensureProjectProviderCommands(input: {
  readonly api: EnvironmentApi | undefined;
  readonly supported: boolean;
  readonly environmentId: string;
  readonly instanceId: ProviderInstanceId;
  readonly cwd: string;
  readonly nowMs?: number;
}): void {
  const call = input.api?.server?.readProjectProviderCommands;
  if (!input.supported || !call) return;
  const nowMs = input.nowMs ?? Date.now();
  const key = projectProviderCommandsKey(input);
  let entry = entries.get(key);
  if (entry === undefined) {
    entry = { data: undefined, readAtMs: undefined, failedAtMs: undefined, inFlight: false };
    entries.set(key, entry);
    while (entries.size > CAPACITY) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }
  if (
    entry.inFlight ||
    (entry.readAtMs !== undefined && nowMs - entry.readAtMs < PROJECT_PROVIDER_COMMANDS_FRESH_MS) ||
    (entry.failedAtMs !== undefined && nowMs - entry.failedAtMs < RETRY_AFTER_FAILURE_MS)
  ) {
    return;
  }
  const current = entry;
  current.inFlight = true;
  void call({ instanceId: input.instanceId, cwd: input.cwd }).then(
    (data) => {
      current.inFlight = false;
      current.data = data;
      current.readAtMs = Date.now();
      current.failedAtMs = undefined;
      notify();
    },
    () => {
      current.inFlight = false;
      current.failedAtMs = Date.now();
    },
  );
}

/**
 * The instance snapshot's lists with a directory's additions. Skills are the same skill when
 * they share a file (or, without one, a name); commands when they share a name. The snapshot's
 * entry wins, so a directory never renames what the user already sees.
 */
export function mergeProjectProviderCommands(
  base: {
    readonly skills: ReadonlyArray<ServerProviderSkill>;
    readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  },
  project: ProviderProjectCommands | undefined,
): {
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
} {
  if (!project || (project.skills.length === 0 && project.slashCommands.length === 0)) return base;
  const skillKey = (skill: ServerProviderSkill) => skill.path || skill.name.toLowerCase();
  const knownSkills = new Set(base.skills.map(skillKey));
  const knownCommands = new Set(base.slashCommands.map((command) => command.name.toLowerCase()));
  const skills = project.skills.filter((skill) => !knownSkills.has(skillKey(skill)));
  const slashCommands = project.slashCommands.filter(
    (command) => !knownCommands.has(command.name.toLowerCase()),
  );
  return skills.length === 0 && slashCommands.length === 0
    ? base
    : {
        skills: [...base.skills, ...skills],
        slashCommands: [...base.slashCommands, ...slashCommands],
      };
}

/** Test seam: forget every entry. */
export function resetProjectProviderCommandsForTests(): void {
  entries.clear();
  listeners.clear();
}
