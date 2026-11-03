// FILE: ProjectSwitcher.logic.ts
// Purpose: The project selector's model: one entry per logical project with its checkout on
//          every node, the `@node` search token, node filter counts, and the flat row list
//          (project rows, their expanded per-node rows, "No project") the combobox renders.
// Layer: Web UI logic, pure. Checkouts come from `buildProjectCheckoutOptions`, nodes from
//        the node catalog; `useProjectSelectorProjects` decides which nodes a draft may move to.

import { CHAT_PROJECT_LABEL } from "@ryco/client-runtime/state/composer";
import type { NodeCatalogEntry } from "@ryco/client-runtime/state/nodes";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";

import type { ProjectCheckoutOption } from "../projectCheckouts.logic";
import { displayProjectPath } from "./projects/projectsModel.logic";

/** What a selector row shows of a node: its badge, its name and whether it is reachable. */
export type ProjectSelectorNode = Pick<
  NodeCatalogEntry,
  "environmentId" | "label" | "isThisDevice" | "iconKind" | "platformOs" | "presence"
>;

/** One checkout of a logical project: the project as it exists on one node. */
export interface ProjectSelectorCheckout {
  /** Combobox value of the checkout's own row. */
  readonly item: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly cwd: string;
  /** `cwd` as rows show it: home-relative where the home directory is recognisable. */
  readonly path: string;
  readonly node: ProjectSelectorNode;
  /** Why the draft cannot move to this checkout; null when it can. */
  readonly unavailableReason: string | null;
}

/** A logical project (one repository) with its checkouts, representative first. */
export interface ProjectSelectorProject {
  /** The logical project key every checkout of the repository shares. */
  readonly key: string;
  /** Combobox value of the project's row. */
  readonly item: string;
  readonly name: string;
  readonly checkouts: ReadonlyArray<ProjectSelectorCheckout>;
  /** The representative checkout's artwork. */
  readonly favicon: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly cwd: string;
    readonly customAvatarContentHash: string | null;
  };
}

/** Combobox value of the "No project" entry; never collides with a project or checkout value. */
export const NO_PROJECT_ITEM = "\u0000no-project";
const NO_PROJECT_SEARCH_TERMS = `${CHAT_PROJECT_LABEL} chat without folder`.toLowerCase();

export function projectSelectorProjectItem(logicalKey: string): string {
  return `p\u0000${logicalKey}`;
}

export function projectSelectorCheckoutItem(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): string {
  return `c\u0000${environmentId}\u0000${projectId}`;
}

/** A checkout path as the selector shows it: `~/Code/ryco` for `/Users/me/Code/ryco`. */
export function projectSelectorPath(cwd: string): string {
  return displayProjectPath(cwd);
}

/**
 * Groups the flat checkout options back into logical projects, keeping their
 * order (sidebar order, representative checkout first). `resolveNode` names the
 * node of each checkout; a null answer leaves the checkout out (a node this
 * client may not list, such as a revoked Hub machine).
 */
export function buildProjectSelectorProjects(input: {
  readonly options: ReadonlyArray<ProjectCheckoutOption>;
  readonly resolveNode: (option: ProjectCheckoutOption) => ProjectSelectorNode | null;
  readonly unavailableReason: (node: ProjectSelectorNode) => string | null;
}): ProjectSelectorProject[] {
  const byKey = new Map<
    string,
    { project: ProjectSelectorProject; checkouts: ProjectSelectorCheckout[] }
  >();
  const reasonByNode = new Map<EnvironmentId, string | null>();
  for (const option of input.options) {
    const node = input.resolveNode(option);
    if (node === null) continue;
    let reason = reasonByNode.get(node.environmentId);
    if (reason === undefined) {
      reason = input.unavailableReason(node);
      reasonByNode.set(node.environmentId, reason);
    }
    const checkout: ProjectSelectorCheckout = {
      item: projectSelectorCheckoutItem(option.environmentId, option.projectId),
      environmentId: option.environmentId,
      projectId: option.projectId,
      cwd: option.cwd,
      path: projectSelectorPath(option.cwd),
      node,
      unavailableReason: reason,
    };
    const existing = byKey.get(option.repositoryKey);
    if (existing) {
      existing.checkouts.push(checkout);
      continue;
    }
    const checkouts = [checkout];
    byKey.set(option.repositoryKey, {
      checkouts,
      project: {
        key: option.repositoryKey,
        item: projectSelectorProjectItem(option.repositoryKey),
        name: option.name,
        checkouts,
        favicon: {
          environmentId: option.environmentId,
          projectId: option.projectId,
          cwd: option.cwd,
          customAvatarContentHash: option.customAvatarContentHash,
        },
      },
    });
  }
  return Array.from(byKey.values(), (entry) => entry.project);
}

/** The search box split into text and the node an `@node` token names. */
export interface ProjectSelectorQuery {
  /** The words to match against names and paths, `@` tokens removed. */
  readonly text: string;
  /** The node an `@` token names; `"none"` when it names no node; null without a token. */
  readonly node: EnvironmentId | "none" | null;
}

function compactLabel(label: string): string {
  return label.toLowerCase().replace(/\s+/gu, "");
}

/**
 * `@mac`, `@studio`: a word starting with `@` filters by the first node whose id
 * or label (lower-cased, without spaces) starts with the rest of the word. A
 * lone `@` filters nothing yet; the last token wins.
 */
export function parseProjectSelectorQuery(
  query: string,
  nodes: ReadonlyArray<Pick<ProjectSelectorNode, "environmentId" | "label">>,
): ProjectSelectorQuery {
  let node: ProjectSelectorQuery["node"] = null;
  const words: string[] = [];
  for (const word of query.trim().split(/\s+/u)) {
    if (word.startsWith("@")) {
      const token = word.slice(1).toLowerCase();
      if (token.length === 0) continue;
      node =
        nodes.find(
          (candidate) =>
            candidate.environmentId.toLowerCase().startsWith(token) ||
            compactLabel(candidate.label).startsWith(token),
        )?.environmentId ?? "none";
    } else if (word.length > 0) {
      words.push(word);
    }
  }
  return { text: words.join(" "), node };
}

/** The query without its `@node` tokens; picking a node chip replaces them. */
export function stripNodeTokens(query: string): string {
  return query.replace(/@\S*\s?/gu, "");
}

/** How many logical projects have a checkout on each node (for the node chips). */
export function countProjectsByNode(
  projects: ReadonlyArray<ProjectSelectorProject>,
): ReadonlyMap<EnvironmentId, number> {
  const counts = new Map<EnvironmentId, number>();
  for (const project of projects) {
    const seen = new Set<EnvironmentId>();
    for (const checkout of project.checkouts) {
      if (seen.has(checkout.environmentId)) continue;
      seen.add(checkout.environmentId);
      counts.set(checkout.environmentId, (counts.get(checkout.environmentId) ?? 0) + 1);
    }
  }
  return counts;
}

export interface ProjectSelectorActiveCheckout {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export type ProjectSelectorRow =
  | { readonly kind: "no-project"; readonly item: typeof NO_PROJECT_ITEM }
  | {
      readonly kind: "project";
      readonly item: string;
      readonly project: ProjectSelectorProject;
      /** The checkouts the node filter keeps. */
      readonly checkouts: ReadonlyArray<ProjectSelectorCheckout>;
      /** The checkout picking the row moves to, and whose path the row shows. */
      readonly preferred: ProjectSelectorCheckout;
      /** Distinct nodes among `checkouts`. */
      readonly nodeCount: number;
      /** More than one checkout, so the row can expand into one row per checkout. */
      readonly expandable: boolean;
      readonly expanded: boolean;
      /** The draft is in this project. */
      readonly current: boolean;
    }
  | {
      readonly kind: "checkout";
      readonly item: string;
      readonly project: ProjectSelectorProject;
      readonly checkout: ProjectSelectorCheckout;
      /** The draft is in this checkout. */
      readonly current: boolean;
    };

function isActiveCheckout(
  checkout: ProjectSelectorCheckout,
  active: ProjectSelectorActiveCheckout | null,
): boolean {
  return (
    active !== null &&
    checkout.environmentId === active.environmentId &&
    checkout.projectId === active.projectId
  );
}

/**
 * The checkout a project row moves to: the draft's own checkout, else one on
 * the draft's node, else the first reachable one (representative first), else
 * the first.
 */
export function preferredProjectCheckout(
  checkouts: ReadonlyArray<ProjectSelectorCheckout>,
  active: ProjectSelectorActiveCheckout | null,
): ProjectSelectorCheckout | null {
  return (
    checkouts.find((checkout) => isActiveCheckout(checkout, active)) ??
    checkouts.find(
      (checkout) =>
        checkout.unavailableReason === null && checkout.environmentId === active?.environmentId,
    ) ??
    checkouts.find((checkout) => checkout.unavailableReason === null) ??
    checkouts[0] ??
    null
  );
}

/**
 * The rows the selector lists, top to bottom. A project matches when its name
 * or a checkout path contains the text; a path match expands the project so
 * the matching checkout shows. The node filter (`@node` or a chip) keeps only
 * checkouts on that node. "No project" leads when it applies and nothing
 * narrows the list to a node.
 */
export function buildProjectSelectorRows(input: {
  readonly projects: ReadonlyArray<ProjectSelectorProject>;
  readonly text: string;
  readonly nodeFilter: EnvironmentId | "none" | null;
  /** Logical keys the user expanded. */
  readonly expanded: ReadonlySet<string>;
  readonly active: ProjectSelectorActiveCheckout | null;
  readonly showNoProject: boolean;
}): ProjectSelectorRow[] {
  const text = input.text.trim().toLowerCase();
  const rows: ProjectSelectorRow[] = [];
  if (
    input.showNoProject &&
    input.nodeFilter === null &&
    (text.length === 0 || NO_PROJECT_SEARCH_TERMS.includes(text))
  ) {
    rows.push({ kind: "no-project", item: NO_PROJECT_ITEM });
  }
  for (const project of input.projects) {
    const checkouts =
      input.nodeFilter === null
        ? project.checkouts
        : project.checkouts.filter((checkout) => checkout.environmentId === input.nodeFilter);
    if (checkouts.length === 0) continue;
    const pathHit =
      text.length > 0 &&
      checkouts.some(
        (checkout) =>
          checkout.path.toLowerCase().includes(text) || checkout.cwd.toLowerCase().includes(text),
      );
    if (text.length > 0 && !pathHit && !project.name.toLowerCase().includes(text)) continue;
    const preferred = preferredProjectCheckout(checkouts, input.active);
    if (!preferred) continue;
    const expandable = checkouts.length > 1;
    const expanded = expandable && (input.expanded.has(project.key) || pathHit);
    const current = project.checkouts.some((checkout) => isActiveCheckout(checkout, input.active));
    rows.push({
      kind: "project",
      item: project.item,
      project,
      checkouts,
      preferred,
      nodeCount: new Set(checkouts.map((checkout) => checkout.environmentId)).size,
      expandable,
      expanded,
      current,
    });
    if (!expanded) continue;
    for (const checkout of checkouts) {
      rows.push({
        kind: "checkout",
        item: checkout.item,
        project,
        checkout,
        current: isActiveCheckout(checkout, input.active),
      });
    }
  }
  return rows;
}

/**
 * The row that stands for the draft, which the combobox marks selected: "No
 * project" for a chat draft; else the draft's own checkout row while its
 * project is expanded, else the draft's project row; null when no listed row
 * is the draft's.
 */
export function projectSelectorValue(
  rows: ReadonlyArray<ProjectSelectorRow>,
  isChatDraft: boolean,
): string | null {
  if (isChatDraft) return NO_PROJECT_ITEM;
  let projectItem: string | null = null;
  for (const row of rows) {
    if (row.kind === "checkout" && row.current) return row.item;
    if (row.kind === "project" && row.current) projectItem = row.item;
  }
  return projectItem;
}

/**
 * The project row a row belongs to: a checkout row's project above it, a
 * project row itself. Null for "No project".
 */
export function projectSelectorParentIndex(
  rows: ReadonlyArray<ProjectSelectorRow>,
  index: number,
): number | null {
  const row = rows[index];
  if (!row || row.kind === "no-project") return null;
  for (let candidate = index; candidate >= 0; candidate -= 1) {
    const above = rows[candidate];
    if (above?.kind === "project" && above.project.key === row.project.key) return candidate;
  }
  return null;
}

/** A project row's second line: "2 nodes · ~/Code/ryco" or "Studio · ~/src/ryco". */
export function projectRowSubline(row: Extract<ProjectSelectorRow, { kind: "project" }>): {
  readonly lead: string;
  readonly path: string;
} {
  return {
    lead: row.nodeCount > 1 ? `${row.nodeCount} nodes · ` : `${row.preferred.node.label} · `,
    path: row.preferred.path,
  };
}

/**
 * Why a draft cannot move to a checkout on `node`: it is offline, or the Hub
 * (hosted or Desktop) says this client cannot start work there. `canMutate` is
 * undefined where no Hub workspace decides it.
 */
export function checkoutUnavailableReason(input: {
  readonly node: Pick<ProjectSelectorNode, "label" | "presence">;
  readonly canMutate: boolean | undefined;
  readonly mutateBlockedReason?: string | null | undefined;
}): string | null {
  if (input.node.presence === "offline") return `${input.node.label} is offline`;
  if (input.canMutate === false) {
    return input.mutateBlockedReason?.trim() || `You can't start threads on ${input.node.label}`;
  }
  return null;
}

/** What a checkout row's meta shows from VCS status that is already loaded. */
export interface CheckoutStatusMeta {
  readonly branch: string | null;
  /** Uncommitted files; null when only the summary view (no working tree) is known. */
  readonly changed: number | null;
  /** Commits behind upstream; null when the remote half is unknown. */
  readonly behind: number | null;
}

export function checkoutStatusMeta(
  status: {
    readonly refName: string | null;
    readonly workingTree: { readonly files: ReadonlyArray<unknown> };
    readonly behindCount: number;
  } | null,
  options: { readonly view: "full" | "summary"; readonly remoteKnown: boolean },
): CheckoutStatusMeta | null {
  if (status === null) return null;
  const full = options.view === "full";
  return {
    branch: status.refName,
    changed: full && status.workingTree.files.length > 0 ? status.workingTree.files.length : null,
    behind: full && options.remoteKnown && status.behindCount > 0 ? status.behindCount : null,
  };
}
