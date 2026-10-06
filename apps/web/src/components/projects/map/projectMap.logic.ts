/**
 * The project map, as data: one logical project across every device it is
 * checked out on. Pure, so the layout and lineage rules are tested on their
 * own and every render follows one geometry.
 *
 *   project
 *   ├─ device (a checkout: the project's folder on one machine)   one column each
 *   │  ├─ workspace (main checkout, worktrees)   on the device's trunk
 *   │  │  └─ thread                              fanned out on demand
 *   │  └─ automation (schedules the device runs) below its workspaces
 */
import type { InboxGlyphKind } from "../../inboxSidebar/inboxRowPresentation";
import type { WorkspaceFact } from "../sections/projectWorkspaces.logic";

export type MapPresenceStatus = "online" | "connecting" | "offline" | "unknown";

export interface MapThread {
  readonly id: string;
  readonly title: string;
  readonly glyph: InboxGlyphKind;
  readonly glyphLabel: string;
  readonly archived: boolean;
  readonly activityAt: string | null;
}

export type MapWorkspaceOrigin =
  | {
      readonly kind: "pr";
      readonly number: number;
      readonly state: "open" | "closed" | "merged" | null;
      readonly isDraft: boolean;
    }
  | { readonly kind: "issue"; readonly number: number }
  | { readonly kind: "work-item"; readonly key: string }
  | null;

export interface MapWorkspace {
  /** The tree's worktree id (registered, or synthesized for the main checkout). */
  readonly id: string;
  /** The registered id the lifecycle service knows, once inspected. */
  readonly registeredId: string | null;
  readonly title: string | null;
  readonly branch: string;
  readonly main: boolean;
  readonly archived: boolean;
  readonly checkoutRemoved: boolean;
  readonly origin: MapWorkspaceOrigin;
  /** What needs care, stated once (inspection facts). */
  readonly facts: readonly WorkspaceFact[];
  readonly threads: readonly MapThread[];
}

export interface MapAutomation {
  readonly id: string;
  readonly title: string;
  readonly enabled: boolean;
  readonly scheduleLabel: string;
  /** Null for a paused, cancelled or finished schedule. */
  readonly nextRunAt: string | null;
  /** Interval length for countdown rings; null for one-off schedules. */
  readonly intervalMs: number | null;
  readonly envMode: "local" | "worktree";
  /** A due run waiting for approval: the proposal to decide. */
  readonly pendingProposalId: string | null;
  readonly running: boolean;
  readonly lastRunFailed: boolean;
  /** Threads its runs started, most recent first. */
  readonly threadIds: readonly string[];
  /** Threads of a run that is executing now. */
  readonly runningThreadIds: readonly string[];
}

export interface MapCheckout {
  /** `${environmentId}\0${projectId}` */
  readonly key: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly cwd: string;
  readonly deviceLabel: string;
  readonly isPrimary: boolean;
  readonly status: MapPresenceStatus;
  readonly workspaces: readonly MapWorkspace[];
  readonly automations: readonly MapAutomation[];
}

export interface MapOptions {
  readonly hiddenCheckouts: ReadonlySet<string>;
  /** Workspace keys whose threads are fanned out. */
  readonly expanded: ReadonlySet<string>;
  readonly showArchived: boolean;
  readonly showAutomations: boolean;
  /** Manual moves (drag), by node key. */
  readonly offsets: ReadonlyMap<string, { readonly dx: number; readonly dy: number }>;
}

export type MapNodeKind = "project" | "device" | "workspace" | "automation" | "thread" | "label";

export interface MapNode {
  readonly key: string;
  readonly kind: MapNodeKind;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly checkoutKey: string | null;
  /** The entity id (workspace id, thread id, automation id); null for project/labels. */
  readonly refId: string | null;
}

export type MapEdgeKind = "device" | "trunk" | "same-branch" | "run";

export interface MapEdge {
  readonly key: string;
  readonly kind: MapEdgeKind;
  readonly from: string;
  readonly to: string;
  readonly d: string;
  /** Work is running through it. */
  readonly flow: boolean;
  /** Leads to something archived, paused or removed. */
  readonly muted: boolean;
}

export interface MapLabel {
  readonly key: string;
  readonly kind: "section" | "same-branch";
  readonly x: number;
  readonly y: number;
  readonly text: string;
}

export interface ProjectMapLayout {
  readonly nodes: readonly MapNode[];
  readonly edges: readonly MapEdge[];
  readonly labels: readonly MapLabel[];
  /** child key → parent key (the tree; run and same-branch links are extra). */
  readonly parent: Readonly<Record<string, string>>;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  };
}

/* Geometry. Heights are fixed so the layout never waits on the DOM. */
export const MAP_SIZE = {
  project: { w: 300, h: 118 },
  device: { w: 302, h: 66 },
  workspace: { w: 268, h: 62 },
  automation: { w: 268, h: 62 },
  thread: { w: 234, h: 34 },
  label: { h: 24 },
} as const;
const COL = 384; // column pitch, one device per column
const IND = 34; // a child's indent from its parent's trunk
const TRUNK = 18; // trunk x inside a parent
const Y_DEVICE = 176;
const Y_ITEMS = 286;
const GAP = { item: 10, thread: 6, section: 16 } as const;

export const mapKey = {
  project: () => "p",
  device: (checkoutKey: string) => `d|${checkoutKey}`,
  workspace: (checkoutKey: string, id: string) => `w|${checkoutKey}|${id}`,
  thread: (checkoutKey: string, id: string) => `t|${checkoutKey}|${id}`,
  automation: (checkoutKey: string, id: string) => `a|${checkoutKey}|${id}`,
};

const isWorking = (thread: MapThread) => thread.glyph === "working";

/** Wire from a parent's trunk down into a child's left side (file-tree style). */
export function trunkPath(
  parent: { readonly x: number; readonly y: number; readonly h: number },
  child: { readonly x: number; readonly y: number; readonly h: number },
): string {
  const tx = parent.x + TRUNK;
  const sy = parent.y + parent.h;
  const iy = child.y + child.h / 2;
  const r = Math.min(12, Math.max(0, iy - sy));
  return `M ${tx} ${sy} L ${tx} ${iy - r} Q ${tx} ${iy} ${tx + r} ${iy} L ${child.x} ${iy}`;
}

/** Smooth wire; "v" leaves downward, "h" sideways. */
export function curvePath(
  a: { readonly x: number; readonly y: number },
  b: { readonly x: number; readonly y: number },
  dir: "h" | "v",
  bend = 0.5,
): string {
  if (dir === "v") {
    const dy = Math.max(28, Math.abs(b.y - a.y) * bend);
    return `M ${a.x} ${a.y} C ${a.x} ${a.y + dy}, ${b.x} ${b.y - dy}, ${b.x} ${b.y}`;
  }
  const dx = Math.max(36, Math.abs(b.x - a.x) * bend);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

/** An arc that bows out to the right between two right-hand ports. */
function arcRight(
  a: { readonly x: number; readonly y: number },
  b: { readonly x: number; readonly y: number },
) {
  const bulge = 34 + Math.min(70, Math.abs(a.y - b.y) * 0.12);
  return `M ${a.x} ${a.y} C ${a.x + bulge} ${a.y}, ${b.x + bulge} ${b.y}, ${b.x} ${b.y}`;
}

export function buildProjectMap(
  checkouts: readonly MapCheckout[],
  options: MapOptions,
): ProjectMapLayout {
  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const labels: MapLabel[] = [];
  const parent: Record<string, string> = {};
  const shown = checkouts.filter((checkout) => !options.hiddenCheckouts.has(checkout.key));
  const width = shown.length ? (shown.length - 1) * COL + MAP_SIZE.device.w : MAP_SIZE.project.w;
  const projectKey = mapKey.project();
  const place = (node: Omit<MapNode, "x" | "y"> & { x: number; y: number }): MapNode => {
    const off = options.offsets.get(node.key);
    return {
      ...node,
      x: Math.round(node.x + (off?.dx ?? 0)),
      y: Math.round(node.y + (off?.dy ?? 0)),
    };
  };
  nodes.push(
    place({
      key: projectKey,
      kind: "project",
      x: width / 2 - MAP_SIZE.project.w / 2,
      y: 0,
      ...MAP_SIZE.project,
      checkoutKey: null,
      refId: null,
    }),
  );

  const working = new Set<string>();
  const muted = new Set<string>();
  const runLinks: Array<{
    from: string;
    threadKey: string;
    workspaceKey: string;
    running: boolean;
  }> = [];

  shown.forEach((checkout, column) => {
    const cx = column * COL;
    const deviceKey = mapKey.device(checkout.key);
    nodes.push(
      place({
        key: deviceKey,
        kind: "device",
        x: cx,
        y: Y_DEVICE,
        ...MAP_SIZE.device,
        checkoutKey: checkout.key,
        refId: null,
      }),
    );
    parent[deviceKey] = projectKey;
    let y = Y_ITEMS;
    let deviceWorking = false;
    const threadWorkspace = new Map<string, string>();
    for (const workspace of checkout.workspaces) {
      if (workspace.archived && !options.showArchived) continue;
      const workspaceKey = mapKey.workspace(checkout.key, workspace.id);
      nodes.push(
        place({
          key: workspaceKey,
          kind: "workspace",
          x: cx + IND,
          y,
          ...MAP_SIZE.workspace,
          checkoutKey: checkout.key,
          refId: workspace.id,
        }),
      );
      parent[workspaceKey] = deviceKey;
      if (workspace.archived || workspace.checkoutRemoved) muted.add(workspaceKey);
      if (workspace.threads.some(isWorking)) {
        working.add(workspaceKey);
        deviceWorking = true;
      }
      for (const thread of workspace.threads) threadWorkspace.set(thread.id, workspaceKey);
      y += MAP_SIZE.workspace.h;
      const threads = options.expanded.has(workspaceKey)
        ? workspace.threads.filter((thread) => options.showArchived || !thread.archived)
        : [];
      if (threads.length) y += GAP.thread + 2;
      for (const thread of threads) {
        const threadKey = mapKey.thread(checkout.key, thread.id);
        nodes.push(
          place({
            key: threadKey,
            kind: "thread",
            x: cx + IND * 2,
            y,
            ...MAP_SIZE.thread,
            checkoutKey: checkout.key,
            refId: thread.id,
          }),
        );
        parent[threadKey] = workspaceKey;
        if (isWorking(thread)) working.add(threadKey);
        if (thread.archived) muted.add(threadKey);
        y += MAP_SIZE.thread.h + GAP.thread;
      }
      y += GAP.item;
    }
    const automations = options.showAutomations ? checkout.automations : [];
    if (automations.length) {
      y += GAP.section - GAP.item;
      labels.push({
        key: `label|${checkout.key}`,
        kind: "section",
        x: cx + IND,
        y,
        text: "Automations",
      });
      y += MAP_SIZE.label.h;
      for (const automation of automations) {
        const automationKey = mapKey.automation(checkout.key, automation.id);
        nodes.push(
          place({
            key: automationKey,
            kind: "automation",
            x: cx + IND,
            y,
            ...MAP_SIZE.automation,
            checkoutKey: checkout.key,
            refId: automation.id,
          }),
        );
        parent[automationKey] = deviceKey;
        if (!automation.enabled) muted.add(automationKey);
        if (automation.running) {
          working.add(automationKey);
          deviceWorking = true;
        }
        for (const threadId of automation.threadIds) {
          const workspaceKey = threadWorkspace.get(threadId);
          if (!workspaceKey) continue;
          runLinks.push({
            from: automationKey,
            threadKey: mapKey.thread(checkout.key, threadId),
            workspaceKey,
            running: automation.runningThreadIds.includes(threadId),
          });
        }
        y += MAP_SIZE.automation.h + GAP.item;
      }
    }
    if (deviceWorking) working.add(deviceKey);
  });

  const byKey = new Map(nodes.map((node) => [node.key, node]));
  for (const [child, par] of Object.entries(parent)) {
    const a = byKey.get(par);
    const b = byKey.get(child);
    if (!a || !b) continue;
    edges.push({
      key: `${par}>${child}`,
      kind: b.kind === "device" ? "device" : "trunk",
      from: par,
      to: child,
      d:
        b.kind === "device"
          ? curvePath({ x: a.x + a.w / 2, y: a.y + a.h }, { x: b.x + b.w / 2, y: b.y }, "v")
          : trunkPath(a, b),
      flow: working.has(child),
      muted: muted.has(child),
    });
  }

  /* Same branch checked out on more than one device: a violet arc between columns. */
  const byBranch = new Map<string, MapNode[]>();
  for (const checkout of shown)
    for (const workspace of checkout.workspaces) {
      if (workspace.main) continue;
      const node = byKey.get(mapKey.workspace(checkout.key, workspace.id));
      if (!node) continue;
      byBranch.set(workspace.branch, [...(byBranch.get(workspace.branch) ?? []), node]);
    }
  for (const [branch, list] of byBranch) {
    const sorted = list.toSorted((left, right) => left.x - right.x);
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1]!;
      const b = sorted[i]!;
      const pa = { x: a.x + a.w, y: a.y + a.h / 2 };
      const pb = { x: b.x - 6, y: b.y + b.h / 2 };
      edges.push({
        key: `same|${branch}|${i}`,
        kind: "same-branch",
        from: a.key,
        to: b.key,
        d: curvePath(pa, pb, "h", 0.55),
        flow: false,
        muted: false,
      });
      labels.push({
        key: `same|${branch}|${i}`,
        kind: "same-branch",
        x: Math.round((pa.x + pb.x) / 2),
        y: Math.round((pa.y + pb.y) / 2),
        text: "same branch",
      });
    }
  }

  /* Started by an automation: an arc on the column's right to each thread a
     run started (to its workspace while the threads are folded). */
  for (const link of runLinks) {
    const a = byKey.get(link.from);
    const b = byKey.get(link.threadKey) ?? byKey.get(link.workspaceKey);
    if (!a || !b) continue;
    edges.push({
      key: `run|${link.from}>${link.threadKey}`,
      kind: "run",
      from: link.from,
      to: b.key,
      d: arcRight({ x: a.x + a.w, y: a.y + a.h / 2 }, { x: b.x + b.w, y: b.y + b.h / 2 }),
      flow: link.running,
      muted: false,
    });
  }

  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const node of nodes) {
    x0 = Math.min(x0, node.x);
    y0 = Math.min(y0, node.y);
    x1 = Math.max(x1, node.x + node.w);
    y1 = Math.max(y1, node.y + node.h);
  }
  return { nodes, edges, labels, parent, bounds: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
}

/**
 * What lights up with a focused node: its ancestors, its descendants, and
 * the run links (an automation and the threads it started light together).
 */
export function mapLineage(layout: ProjectMapLayout, focusKey: string): ReadonlySet<string> {
  const lit = new Set([focusKey]);
  for (let key = layout.parent[focusKey]; key; key = layout.parent[key]) lit.add(key);
  const children = new Map<string, string[]>();
  for (const [child, par] of Object.entries(layout.parent))
    children.set(par, [...(children.get(par) ?? []), child]);
  const stack = [focusKey];
  while (stack.length) {
    const key = stack.pop()!;
    for (const child of children.get(key) ?? []) {
      if (lit.has(child)) continue;
      lit.add(child);
      stack.push(child);
    }
  }
  for (const edge of layout.edges) {
    if (edge.kind !== "run") continue;
    if (edge.from === focusKey) lit.add(edge.to);
    if (edge.to === focusKey) lit.add(edge.from);
  }
  return lit;
}

/** Every threads key that can fan out: for "Threads" (expand all). */
export function expandableWorkspaceKeys(checkouts: readonly MapCheckout[]): string[] {
  return checkouts.flatMap((checkout) =>
    checkout.workspaces
      .filter((workspace) => workspace.threads.length > 0)
      .map((workspace) => mapKey.workspace(checkout.key, workspace.id)),
  );
}

/** Share of the interval already elapsed, for countdown rings (0 when unknown). */
export function automationCycle(automation: MapAutomation, nowMs: number): number {
  if (!automation.enabled || !automation.nextRunAt || !automation.intervalMs) return 0;
  const remaining = Date.parse(automation.nextRunAt) - nowMs;
  return Math.min(1, Math.max(0, 1 - remaining / automation.intervalMs));
}
