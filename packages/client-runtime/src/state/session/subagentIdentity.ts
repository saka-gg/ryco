/**
 * Provider-neutral presentation identity shared by the fleet and transcript
 * surfaces. Identity is derived only from stable task keys and retained
 * metadata; live status, usage, timestamps, and list position never affect it.
 */

export interface SubagentIdentity {
  readonly codename: string;
  readonly avatarKey: string;
  readonly role: string | null;
  readonly taskLabel: string | null;
}

export interface SubagentIdentityInput {
  readonly key: string;
  readonly role?: string | null;
  readonly taskLabel?: string | null;
}

const GENERIC_ROLE_LABELS: ReadonlySet<string> = new Set([
  "agent",
  "subagent",
  "subagent task",
  "task",
]);

const SUBAGENT_CODENAMES = [
  "Turing",
  "Dirac",
  "Hegel",
  "Arendt",
  "Boyle",
  "Locke",
  "Epicurus",
  "Curie",
  "Bohr",
  "Newton",
  "Euler",
  "Gauss",
  "Hopper",
  "Lovelace",
  "Noether",
  "Pascal",
  "Tesla",
  "Darwin",
  "Kepler",
  "Faraday",
  "Planck",
  "Heisenberg",
  "Maxwell",
  "Fermi",
  "Feynman",
  "Lagrange",
  "Riemann",
  "Babbage",
  "Shannon",
  "Ramanujan",
  "Galileo",
  "Copernicus",
  "Pasteur",
  "Mendel",
  "Hawking",
  "Lavoisier",
  "Fourier",
  "Pauli",
  "Kant",
  "Plato",
  "Socrates",
  "Aristotle",
  "Nietzsche",
  "Spinoza",
  "Descartes",
  "Hume",
  "Leibniz",
  "Wittgenstein",
  "Russell",
  "Camus",
  "Sartre",
  "Voltaire",
  "Confucius",
  "Seneca",
  "Aurelius",
  "Diogenes",
] as const;

function cleanText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function titleCaseCompact(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

export function formatSubagentRoleLabel(value: string | null | undefined): string | null {
  const role = cleanText(value);
  if (!role || GENERIC_ROLE_LABELS.has(role.toLocaleLowerCase())) {
    return null;
  }
  return titleCaseCompact(role);
}

export function subagentRoleDuplicatesLabel(
  role: string | null | undefined,
  label: string | null | undefined,
): boolean {
  const left = cleanText(role)?.toLocaleLowerCase();
  const right = cleanText(label)?.toLocaleLowerCase();
  return left !== undefined && left !== null && left === right;
}

/** Titles the runtime fold invents when the provider reported none. */
const GENERIC_TASK_LABELS: ReadonlySet<string> = new Set([...GENERIC_ROLE_LABELS, "agent task"]);

/**
 * The name a fleet row leads with. Providers that label agents functionally
 * (Claude workflow members such as `verify:implementor`, Agent-tool spawns by
 * their description) keep that label; the stable codename is only the
 * fallback for agents that arrive without one.
 */
export function resolveSubagentDisplayLabel(input: {
  readonly id: string;
  readonly title: string | null | undefined;
  readonly codename: string;
}): string {
  const title = cleanText(input.title);
  if (
    !title ||
    GENERIC_TASK_LABELS.has(title.toLocaleLowerCase()) ||
    canonicalSubagentIdentityKey(title) === canonicalSubagentIdentityKey(input.id)
  ) {
    return input.codename;
  }
  return title;
}

/**
 * Display labels for a whole roster, in spawn order. Functional labels can
 * repeat (two `Explore` spawns, a retried `review:bugs` slot), and rows must
 * stay tellable apart, so only labels that collide gain an ordinal
 * (`Explore`, `Explore 2`); unique labels are left alone.
 */
export function resolveSubagentDisplayLabels(
  agents: ReadonlyArray<{
    readonly id: string;
    readonly title: string | null | undefined;
    readonly codename: string;
  }>,
): ReadonlyMap<string, string> {
  const base = agents.map((agent) => [agent.id, resolveSubagentDisplayLabel(agent)] as const);
  const totals = new Map<string, number>();
  for (const [, label] of base) totals.set(label, (totals.get(label) ?? 0) + 1);
  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const [id, label] of base) {
    if ((totals.get(label) ?? 0) < 2) {
      labels.set(id, label);
      continue;
    }
    const ordinal = (seen.get(label) ?? 0) + 1;
    seen.set(label, ordinal);
    labels.set(id, ordinal === 1 ? label : `${label} ${ordinal}`);
  }
  return labels;
}

/**
 * Splits a workflow label's `scope:name` convention (`verify:implementor`,
 * `review:src/app.ts`) so the scope can be set back. Labels without a short,
 * space-free scope come back whole.
 */
export function splitSubagentLabelScope(label: string): {
  readonly scope: string | null;
  readonly name: string;
} {
  const match = /^([^\s:]{1,24}):(?!\/\/)(\S.*)$/u.exec(label.trim());
  return match ? { scope: match[1]!, name: match[2]! } : { scope: null, name: label.trim() };
}

/** Runtime task ids are raw while transcript keys use `subagent:<id>`. */
export function canonicalSubagentIdentityKey(key: string): string {
  const trimmed = key.trim();
  const withoutPrefix = trimmed.startsWith("subagent:")
    ? trimmed.slice("subagent:".length)
    : trimmed;
  return withoutPrefix || trimmed || "agent";
}

function hashSubagentSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function codenamePreferenceOrder(seed: string): number[] {
  const order = Array.from({ length: SUBAGENT_CODENAMES.length }, (_, index) => index);
  let state = hashSubagentSeed(seed) || 1;
  for (let index = order.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 0x01000193) ^ (index + 1)) >>> 0;
    const swapIndex = state % (index + 1);
    const swap = order[index]!;
    order[index] = order[swapIndex]!;
    order[swapIndex] = swap;
  }
  return order;
}

function assignCodenames(canonicalKeys: ReadonlyArray<string>): Map<string, string> {
  const names = new Map<string, string>();
  const taken = new Set<string>();
  const uniqueKeys = [...new Set(canonicalKeys)].toSorted((left, right) =>
    left.localeCompare(right),
  );

  for (const key of uniqueKeys) {
    const preference = codenamePreferenceOrder(key);
    let chosen: string | null = null;
    for (const index of preference) {
      const candidate = SUBAGENT_CODENAMES[index]!;
      if (!taken.has(candidate.toLocaleLowerCase())) {
        chosen = candidate;
        break;
      }
    }
    if (chosen === null) {
      const base = SUBAGENT_CODENAMES[preference[0]!]!;
      let suffix = 2;
      while (taken.has(`${base} ${suffix}`.toLocaleLowerCase())) suffix += 1;
      chosen = `${base} ${suffix}`;
    }
    taken.add(chosen.toLocaleLowerCase());
    names.set(key, chosen);
  }
  return names;
}

export function assignSubagentIdentities(
  inputs: ReadonlyArray<SubagentIdentityInput>,
): ReadonlyMap<string, SubagentIdentity> {
  const canonicalByInputKey = new Map(
    inputs.map((input) => [input.key, canonicalSubagentIdentityKey(input.key)] as const),
  );
  const codenames = assignCodenames([...canonicalByInputKey.values()]);
  const identities = new Map<string, SubagentIdentity>();

  for (const input of inputs) {
    const canonicalKey =
      canonicalByInputKey.get(input.key) ?? canonicalSubagentIdentityKey(input.key);
    identities.set(input.key, {
      codename: codenames.get(canonicalKey) ?? canonicalKey,
      avatarKey: canonicalKey,
      role: formatSubagentRoleLabel(input.role),
      taskLabel: cleanText(input.taskLabel),
    });
  }
  return identities;
}
