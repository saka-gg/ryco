import type { AgentControlProposalId } from "@ryco/contracts";
import {
  ArchiveIcon,
  ClockIcon,
  LayersIcon,
  MaximizeIcon,
  MessageSquareIcon,
  MinusIcon,
  PlusIcon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { useEvent } from "../../../hooks/useEvent";
import { readMotionDurationMs } from "../../../lib/perf/motion";
import { cn } from "../../../lib/utils";
import { projectRepositoryLabel } from "../projectsModel.logic";
import type { WorkspaceReviewAction } from "../projectsSearch";
import { useProjectsPage, useProjectsSelection } from "../ProjectsPageContext";
import {
  buildProjectMap,
  expandableWorkspaceKeys,
  mapKey,
  mapLineage,
  type MapAutomation,
  type MapLabel,
  type MapNode,
  type MapOptions,
  type MapThread,
  type MapWorkspace,
} from "./projectMap.logic";
import { ProjectMapInspector, mapInspectorWidth, type MapSelection } from "./ProjectMapInspector";
import {
  MapAutomationNode,
  MapDeviceNode,
  MapPorts,
  MapProjectNode,
  MapThreadNode,
  MapWorkspaceNode,
  type MapPort,
} from "./ProjectMapNodes";
import { useMapCamera, type MapBounds } from "./useMapCamera";
import { useProjectMapCheckouts, type MapCheckoutDetail } from "./useProjectMapCheckouts";

const EXIT_MS = 240;
/** How much of the canvas's right edge the inspector covers for a selection. */
const inspectorInset = (selection: MapSelection | null) =>
  selection ? mapInspectorWidth(selection) + 24 : 0;
const TOOLBAR_INSET = 44;

function selectionKey(selection: MapSelection | null): string | null {
  if (!selection) return null;
  switch (selection.kind) {
    case "project":
      return mapKey.project();
    case "device":
      return mapKey.device(selection.checkoutKey);
    case "workspace":
      return mapKey.workspace(selection.checkoutKey, selection.id);
    case "automation":
      return mapKey.automation(selection.checkoutKey, selection.id);
    case "thread":
      return mapKey.thread(selection.checkoutKey, selection.id);
  }
}

/** The checkout and tree id of a workspace a URL names (registered or tree id). */
function findWorkspaceTarget(
  details: readonly MapCheckoutDetail[],
  requested: string | null,
): { readonly checkoutKey: string; readonly id: string } | null {
  if (!requested) return null;
  for (const detail of details)
    for (const workspace of detail.checkout.workspaces)
      if (workspace.registeredId === requested || workspace.id === requested)
        return { checkoutKey: detail.checkout.key, id: workspace.id };
  return null;
}

function selectionOf(node: MapNode): MapSelection | null {
  if (node.kind === "project") return { kind: "project" };
  if (!node.checkoutKey) return null;
  if (node.kind === "device") return { kind: "device", checkoutKey: node.checkoutKey };
  if (!node.refId) return null;
  if (node.kind === "workspace")
    return { kind: "workspace", checkoutKey: node.checkoutKey, id: node.refId };
  if (node.kind === "automation")
    return { kind: "automation", checkoutKey: node.checkoutKey, id: node.refId };
  if (node.kind === "thread")
    return { kind: "thread", checkoutKey: node.checkoutKey, id: node.refId };
  return null;
}

/**
 * Things that just left stay a moment as `exiting` so they can fade out
 * instead of vanishing (a folded thread, a removed worktree, its wire). Each
 * departure starts its own short timer; with motion off nothing is kept.
 */
function useRetained<T extends { readonly key: string }>(items: readonly T[], enabled: boolean) {
  const [previous, setPrevious] = useState(items);
  const [exiting, setExiting] = useState<{ readonly batch: number; readonly items: readonly T[] }>({
    batch: 0,
    items: [],
  });
  if (previous !== items) {
    setPrevious(items);
    const live = new Set(items.map((item) => item.key));
    const gone = enabled ? previous.filter((item) => !live.has(item.key)) : [];
    const kept = exiting.items.filter((item) => !live.has(item.key));
    if (gone.length > 0 || kept.length !== exiting.items.length) {
      setExiting({
        batch: gone.length > 0 ? exiting.batch + 1 : exiting.batch,
        items: [...kept, ...gone],
      });
    }
  }
  useEffect(() => {
    if (exiting.batch === 0) return;
    const timer = window.setTimeout(
      () => setExiting((current) => ({ batch: current.batch, items: [] })),
      EXIT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [exiting.batch]);
  return exiting.items;
}

/** What a node shows, captured so a node that left can still fade out as it was. */
interface NodeModel {
  readonly key: string;
  readonly node: MapNode;
  readonly detail: MapCheckoutDetail | null;
  readonly workspace: MapWorkspace | null;
  readonly automation: MapAutomation | null;
  readonly thread: MapThread | null;
}

const PORTS: Record<MapNode["kind"], readonly MapPort[]> = {
  project: ["bottom"],
  device: ["top", "trunk"],
  workspace: ["left"],
  automation: ["left"],
  thread: ["left"],
  label: [],
};

const ToolChip = memo(function ToolChip(props: {
  readonly pressed: boolean;
  readonly onClick: () => void;
  readonly icon: ReactNode;
  readonly children: ReactNode;
  readonly label?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.pressed}
      aria-label={props.label}
      onClick={props.onClick}
      className="map-chip inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs outline-hidden transition-colors duration-(--app-motion-duration-chip) focus-visible:ring-2 focus-visible:ring-ring"
    >
      {props.icon}
      {props.children}
    </button>
  );
});

/**
 * The project map: one canvas for the whole logical project. The project
 * sits on top; every device is a column holding its workspaces and the
 * automations it runs; a workspace's threads fan out on demand. Wires carry
 * a slow dash where work is running. Hover lights a lineage, click inspects,
 * drag rearranges and Tidy puts it back.
 */
export function ProjectMap() {
  const { nav } = useProjectsPage();
  const { snapshot } = useProjectsSelection();
  const { details, sources } = useProjectMapCheckouts(snapshot);
  const [view, setView] = useState<Omit<MapOptions, "offsets">>(() => ({
    hiddenCheckouts: new Set(),
    expanded: new Set(),
    showArchived: true,
    showAutomations: true,
  }));
  const [offsets, setOffsets] = useState<ReadonlyMap<string, { dx: number; dy: number }>>(
    new Map(),
  );
  const checkouts = useMemo(() => details.map((detail) => detail.checkout), [details]);
  const layout = useMemo(
    () => buildProjectMap(checkouts, { ...view, offsets }),
    [checkouts, offsets, view],
  );
  const [motionOn] = useState(() => readMotionDurationMs("--app-motion-duration-pop", 200) > 0);
  const detailByKey = useMemo(
    () => new Map(details.map((detail) => [detail.checkout.key, detail])),
    [details],
  );
  const models = useMemo<readonly NodeModel[]>(
    () =>
      layout.nodes.map((node) => {
        const detail = node.checkoutKey ? (detailByKey.get(node.checkoutKey) ?? null) : null;
        const workspaces = detail?.checkout.workspaces ?? [];
        return {
          key: node.key,
          node,
          detail,
          workspace:
            node.kind === "workspace"
              ? (workspaces.find((item) => item.id === node.refId) ?? null)
              : null,
          automation:
            node.kind === "automation"
              ? (detail?.checkout.automations.find((item) => item.id === node.refId) ?? null)
              : null,
          thread:
            node.kind === "thread"
              ? (workspaces
                  .flatMap((item) => item.threads)
                  .find((item) => item.id === node.refId) ?? null)
              : null,
        };
      }),
    [detailByKey, layout.nodes],
  );
  const exitingNodes = useRetained(models, motionOn);
  const exitingEdges = useRetained(layout.edges, motionOn);

  const [selection, setSelection] = useState<MapSelection | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const selectedKey = selectionKey(selection);
  const focusKey = hover ?? selectedKey;
  const lit = useMemo(
    () =>
      focusKey && layout.nodes.some((node) => node.key === focusKey)
        ? mapLineage(layout, focusKey)
        : null,
    [focusKey, layout],
  );
  const inspectorOpen = selection !== null;
  const inset = inspectorInset(selection);

  const layoutRef = useRef(layout);
  /* The inset of the selection being opened, before React has rendered it. */
  const selectionInset = useRef(0);
  useEffect(() => {
    layoutRef.current = layout;
    selectionInset.current = inset;
  }, [inset, layout]);

  /* The camera asks for a fit (double-click); the map knows what to fit. */
  const fitRequest = useRef<(animate: boolean) => void>(() => {});
  /* Until the reader moves the camera, the map keeps fitting as data arrives. */
  const autoFit = useRef(true);
  const {
    hostRef,
    worldRef,
    camera: cameraRef,
    zoom,
    fit,
    zoomBy,
    reveal,
  } = useMapCamera({
    onFit: () => fitRequest.current(true),
    onBackgroundClick: () => setSelection(null),
    onUserMove: () => {
      autoFit.current = false;
    },
  });
  const fitAll = useEvent((animate: boolean) => {
    autoFit.current = true;
    fit(layoutRef.current.bounds, {
      animate,
      padding: 56,
      maxZoom: 1,
      insetRight: inset,
      insetTop: TOOLBAR_INSET,
    });
  });
  useEffect(() => {
    fitRequest.current = fitAll;
  }, [fitAll]);

  /* Fit when the project's first checkout arrives and on every project change;
     after that, refit as checkouts, workspaces and automations load in, until
     the reader pans, zooms or drags. */
  const fittedFor = useRef<string | null>(null);
  const hasNodes = layout.nodes.length > 1;
  const { w: boundsW, h: boundsH } = layout.bounds;
  useEffect(() => {
    if (!hasNodes || boundsW <= 0 || boundsH <= 0) return;
    const first = fittedFor.current === null;
    if (fittedFor.current !== snapshot.projectKey) {
      fittedFor.current = snapshot.projectKey;
      autoFit.current = true;
    } else if (!autoFit.current) return;
    const frame = requestAnimationFrame(() => fitAll(!first));
    return () => cancelAnimationFrame(frame);
  }, [boundsH, boundsW, fitAll, hasNodes, snapshot.projectKey]);

  /* Reveal a selection the inspector would cover. */
  const revealKey = useEvent((key: string, withChildren: boolean) => {
    const nodes = layoutRef.current.nodes;
    const target = nodes.find((node) => node.key === key);
    if (!target) return;
    let box: MapBounds = target;
    if (withChildren) {
      const kids = nodes.filter((node) => layoutRef.current.parent[node.key] === key);
      if (kids.length) {
        const bottom = Math.max(...kids.map((node) => node.y + node.h));
        box = { x: target.x, y: target.y, w: target.w + 34, h: bottom - target.y };
      }
    }
    reveal(box, {
      insetRight: selectionInset.current,
      insetTop: TOOLBAR_INSET,
    });
  });
  const select = useEvent((next: MapSelection | null) => {
    setSelection(next);
    selectionInset.current = inspectorInset(next);
    const key = selectionKey(next);
    if (key) requestAnimationFrame(() => revealKey(key, false));
  });

  /* A workspace (and review) named by the URL: from a sidebar or Inbox menu. */
  const requested = nav.search.workspace ?? null;
  const requestedReview = nav.search.review;
  const target = useMemo(() => findWorkspaceTarget(details, requested), [details, requested]);
  const [landed, setLanded] = useState<string | null>(null);
  const landingKey = target
    ? JSON.stringify([target.checkoutKey, target.id, requestedReview ?? null])
    : null;
  if (landingKey !== landed) {
    setLanded(landingKey);
    if (target) {
      setSelection({
        kind: "workspace",
        checkoutKey: target.checkoutKey,
        id: target.id,
        review: requestedReview,
      });
      setView((current) =>
        current.showArchived && !current.hiddenCheckouts.has(target.checkoutKey)
          ? current
          : { ...current, showArchived: true, hiddenCheckouts: new Set() },
      );
    }
  }
  /* A landing happens once: bring it into view, then take the target out of
     the URL so dismissing it sticks and the same menu link lands again. */
  const consumeTarget = useEvent(() => nav.consumeWorkspaceTarget());
  useEffect(() => {
    if (!landingKey) return;
    const [checkoutKey, id] = JSON.parse(landingKey) as [string, string];
    selectionInset.current = inspectorInset({ kind: "device", checkoutKey });
    const frame = requestAnimationFrame(() => {
      revealKey(mapKey.workspace(checkoutKey, id), false);
      consumeTarget();
    });
    return () => cancelAnimationFrame(frame);
  }, [consumeTarget, landingKey, revealKey]);

  /* A review opens and closes inside the inspector. */
  const onReview = useEvent((action: WorkspaceReviewAction | undefined) => {
    setSelection((current) =>
      current?.kind === "workspace" ? { ...current, review: action } : current,
    );
  });

  const openSettings = useCallback(
    (input?: { readonly checkoutKey?: string; readonly section?: "automations" }) => {
      const detail = input?.checkoutKey
        ? details.find((candidate) => candidate.checkout.key === input.checkoutKey)
        : null;
      nav.showSettings({
        ...(input?.section ? { section: input.section } : {}),
        ...(detail
          ? {
              checkout: { environmentId: detail.member.environmentId, projectId: detail.member.id },
            }
          : {}),
      });
    },
    [details, nav],
  );

  /* Escape closes the inspector (and a review inside it). */
  useEffect(() => {
    if (!selection) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Escape in a field or popup belongs to it (a name edit, a menu).
      if (
        event.target instanceof Element &&
        event.target.closest(
          "input, textarea, select, [contenteditable], [role=menu], [role=listbox], [role=dialog], [role=alertdialog]",
        )
      )
        return;
      setSelection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection]);

  /* Drag a node to move it; a press without movement selects it. */
  const drag = useRef<{
    key: string;
    x: number;
    y: number;
    base: { dx: number; dy: number };
    moved: boolean;
    node: MapNode;
  } | null>(null);
  const onNodePointerDown = useEvent((event: React.PointerEvent, node: MapNode) => {
    if (
      event.button !== 0 ||
      (event.target as Element).closest("[data-map-toggle], [data-map-approve]")
    )
      return;
    event.stopPropagation();
    drag.current = {
      key: node.key,
      x: event.clientX,
      y: event.clientY,
      base: offsets.get(node.key) ?? { dx: 0, dy: 0 },
      moved: false,
      node,
    };
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
  });
  const onNodePointerMove = useEvent((event: React.PointerEvent) => {
    const current = drag.current;
    if (!current) return;
    const k = cameraRef.current.k;
    const dx = (event.clientX - current.x) / k;
    const dy = (event.clientY - current.y) / k;
    if (!current.moved && Math.hypot(dx, dy) < 4) return;
    if (!current.moved) {
      current.moved = true;
      autoFit.current = false;
      setDragKey(current.key);
    }
    setOffsets((map) =>
      new Map(map).set(current.key, { dx: current.base.dx + dx, dy: current.base.dy + dy }),
    );
  });
  const onNodePointerUp = useEvent(() => {
    const current = drag.current;
    drag.current = null;
    if (!current) return;
    if (current.moved) {
      setDragKey(null);
      return;
    }
    const next = selectionOf(current.node);
    if (next) select(next);
  });

  const toggleExpanded = useCallback((key: string) => {
    setView((current) => {
      const expanded = new Set(current.expanded);
      if (expanded.has(key)) expanded.delete(key);
      else expanded.add(key);
      return { ...current, expanded };
    });
  }, []);
  const refit = () => requestAnimationFrame(() => requestAnimationFrame(() => fitAll(true)));

  /* Approving from the canvas opens the automation, so the outcome (or a
     refusal) is visible in its inspector. */
  const approve = useEvent((detail: MapCheckoutDetail, automation: MapAutomation) => {
    if (!automation.pendingProposalId) return;
    select({ kind: "automation", checkoutKey: detail.checkout.key, id: automation.id });
    void detail.decide(automation.pendingProposalId as AgentControlProposalId, "accept");
  });

  const totals = useMemo(() => {
    let workspaces = 0;
    let threads = 0;
    for (const checkout of checkouts)
      for (const workspace of checkout.workspaces) {
        if (workspace.archived) continue;
        workspaces += 1;
        threads += workspace.threads.filter((thread) => !thread.archived).length;
      }
    return { workspaces, threads };
  }, [checkouts]);
  const allExpandable = useMemo(() => expandableWorkspaceKeys(checkouts), [checkouts]);

  function renderNode(model: NodeModel, index: number, state: "live" | "exiting") {
    const { node, detail, workspace, automation, thread } = model;
    let body: ReactNode = null;
    if (node.kind === "project")
      body = (
        <MapProjectNode
          snapshot={snapshot}
          devices={checkouts.length}
          workspaces={totals.workspaces}
          threads={totals.threads}
          repository={projectRepositoryLabel(snapshot.repositoryIdentity)}
        />
      );
    else if (node.kind === "device" && detail) body = <MapDeviceNode checkout={detail.checkout} />;
    else if (workspace)
      body = (
        <MapWorkspaceNode
          workspace={workspace}
          expanded={view.expanded.has(node.key)}
          onToggleThreads={() => {
            toggleExpanded(node.key);
            requestAnimationFrame(() => requestAnimationFrame(() => revealKey(node.key, true)));
          }}
        />
      );
    else if (automation && detail)
      body = (
        <MapAutomationNode
          automation={automation}
          canDecide={detail.automationDisabledReason === null}
          disabledReason={detail.automationDisabledReason}
          busy={detail.automationBusy}
          onApprove={() => approve(detail, automation)}
        />
      );
    else if (thread) body = <MapThreadNode thread={thread} />;
    if (!body) return null;
    const live = state === "live";
    return (
      <div
        key={node.key}
        data-map-node={node.kind}
        data-key={node.key}
        data-state={state}
        data-lit={lit ? (lit.has(node.key) ? "on" : "off") : undefined}
        data-selected={live && node.key === selectedKey ? "" : undefined}
        data-dragging={node.key === dragKey ? "" : undefined}
        data-muted={
          workspace?.archived ||
          workspace?.checkoutRemoved ||
          automation?.enabled === false ||
          thread?.archived
            ? ""
            : undefined
        }
        data-due={automation?.pendingProposalId ? "" : undefined}
        className="map-node absolute top-0 left-0"
        style={
          {
            transform: `translate(${node.x}px, ${node.y}px)`,
            width: node.w,
            height: node.h,
            "--map-i": Math.min(index, 24),
          } as CSSProperties
        }
        onPointerDown={live ? (event) => onNodePointerDown(event, node) : undefined}
        onPointerMove={live ? onNodePointerMove : undefined}
        onPointerUp={live ? onNodePointerUp : undefined}
        onPointerEnter={live ? () => setHover(node.key) : undefined}
        onPointerLeave={
          live ? () => setHover((current) => (current === node.key ? null : current)) : undefined
        }
      >
        <div className="map-card relative size-full">
          <MapPorts ports={PORTS[node.kind]} />
          {body}
        </div>
      </div>
    );
  }

  const labelClass = (label: MapLabel) =>
    label.kind === "section" ? "map-section-label" : "map-same-label";

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {sources}
      <div
        ref={hostRef}
        data-project-map=""
        data-focus={lit ? "" : undefined}
        data-dragging={dragKey ? "" : undefined}
        className="map-canvas @container/map relative min-h-0 flex-1 overflow-clip select-none"
      >
        <div aria-hidden className="map-grid pointer-events-none absolute inset-0" />
        <div ref={worldRef} className="map-world absolute top-0 left-0 origin-top-left">
          <svg aria-hidden className="map-wires absolute top-0 left-0 size-px overflow-visible">
            {layout.edges.map((edge) => {
              const hot = lit ? lit.has(edge.from) && lit.has(edge.to) : false;
              return (
                <path
                  key={edge.key}
                  className="map-wire"
                  data-kind={edge.kind}
                  data-flow={edge.flow && !edge.muted ? "" : undefined}
                  data-muted={edge.muted ? "" : undefined}
                  data-lit={lit ? (hot ? "on" : "off") : undefined}
                  d={edge.d}
                  style={{ d: `path("${edge.d}")` } as CSSProperties}
                />
              );
            })}
            {exitingEdges.map((edge) => (
              <path
                key={edge.key}
                className="map-wire"
                data-state="exiting"
                data-kind={edge.kind}
                data-muted={edge.muted ? "" : undefined}
                d={edge.d}
              />
            ))}
          </svg>
          {layout.labels.map((label) => (
            <div
              key={label.key}
              className={cn(
                "map-label pointer-events-none absolute top-0 left-0",
                labelClass(label),
              )}
              data-dim={lit ? "" : undefined}
              style={{ transform: `translate(${label.x}px, ${label.y}px)` }}
            >
              {label.kind === "section" ? (
                <span className="inline-flex items-center gap-1.5 text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">
                  <ClockIcon aria-hidden className="size-3" />
                  {label.text}
                </span>
              ) : (
                <span className="map-same-chip">{label.text}</span>
              )}
            </div>
          ))}
          {models.map((model, index) => renderNode(model, index, "live"))}
          {exitingNodes.map((model, index) => renderNode(model, index, "exiting"))}
        </div>

        <div
          data-map-ui
          className="absolute top-3 left-3.5 z-10 flex flex-wrap items-center gap-1.5"
        >
          {details.length > 1
            ? details.map((detail) => (
                <ToolChip
                  key={detail.checkout.key}
                  pressed={!view.hiddenCheckouts.has(detail.checkout.key)}
                  label={`Show ${detail.checkout.deviceLabel}`}
                  icon={null}
                  onClick={() => {
                    setView((current) => {
                      const hidden = new Set(current.hiddenCheckouts);
                      if (hidden.has(detail.checkout.key)) hidden.delete(detail.checkout.key);
                      else hidden.add(detail.checkout.key);
                      return { ...current, hiddenCheckouts: hidden };
                    });
                    refit();
                  }}
                >
                  {detail.checkout.deviceLabel}
                </ToolChip>
              ))
            : null}
          {details.length > 1 ? <span aria-hidden className="mx-0.5 h-4 w-px bg-border" /> : null}
          <ToolChip
            pressed={view.expanded.size > 0}
            icon={<MessageSquareIcon className="size-3.5" />}
            onClick={() => {
              setView((current) => ({
                ...current,
                expanded:
                  allExpandable.length > 0 &&
                  allExpandable.every((key) => current.expanded.has(key))
                    ? new Set()
                    : new Set(allExpandable),
              }));
              refit();
            }}
          >
            Threads
          </ToolChip>
          <ToolChip
            pressed={view.showAutomations}
            icon={<ClockIcon className="size-3.5" />}
            onClick={() =>
              setView((current) => ({ ...current, showAutomations: !current.showAutomations }))
            }
          >
            Automations
          </ToolChip>
          <ToolChip
            pressed={view.showArchived}
            icon={<ArchiveIcon className="size-3.5" />}
            onClick={() =>
              setView((current) => ({ ...current, showArchived: !current.showArchived }))
            }
          >
            Archived
          </ToolChip>
          {offsets.size > 0 ? (
            <ToolChip
              pressed
              icon={<LayersIcon className="size-3.5" />}
              onClick={() => setOffsets(new Map())}
            >
              Tidy
            </ToolChip>
          ) : null}
        </div>

        <div
          data-map-ui
          aria-hidden
          className="map-legend absolute bottom-3.5 left-3.5 z-10 flex items-center gap-3 rounded-full border border-border bg-popover px-3 py-1 text-[11px] text-muted-foreground @max-[46rem]/map:hidden"
        >
          <span className="inline-flex items-center gap-1.5">
            <svg width="22" height="6" className="map-legend-run">
              <path d="M1 3h20" />
            </svg>
            Running
          </span>
          <span className="inline-flex items-center gap-1.5">
            <svg width="22" height="6" className="map-legend-same">
              <path d="M1 3h20" />
            </svg>
            Same branch
          </span>
          <span className="inline-flex items-center gap-1.5">
            <svg width="22" height="6" className="map-legend-auto">
              <path d="M1 3h20" />
            </svg>
            Started by automation
          </span>
        </div>

        <div
          data-map-ui
          className={cn(
            "absolute bottom-3.5 z-10 flex items-center gap-0.5 rounded-[10px] border border-border bg-popover p-[3px] transition-[right] duration-(--app-motion-duration-pane) ease-(--app-motion-ease)",
          )}
          style={{ right: inspectorOpen ? inset : 14 }}
        >
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => zoomBy(0.8)}
            className="map-zoom-button"
          >
            <MinusIcon className="size-3.5" />
          </button>
          <span className="w-10 text-center text-[11px] text-muted-foreground tabular-nums">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => zoomBy(1.25)}
            className="map-zoom-button"
          >
            <PlusIcon className="size-3.5" />
          </button>
          <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
          <button
            type="button"
            aria-label="Fit to view"
            onClick={() => fitAll(true)}
            className="map-zoom-button"
          >
            <MaximizeIcon className="size-3.5" />
          </button>
        </div>

        <ProjectMapInspector
          selection={selection}
          snapshot={snapshot}
          details={details}
          onSelect={select}
          onReview={onReview}
          onOpenSettings={openSettings}
        />
      </div>
    </div>
  );
}
