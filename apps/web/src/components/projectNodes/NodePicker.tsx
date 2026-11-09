// FILE: NodePicker.tsx
// Purpose: Picks one node: cards (icon, name, "this device", OS and presence, projects and code
//          roots) for a dialog's node step, or compact chips for filters and inline choices.
//          Unavailable nodes stay visible, disabled with their reason.
// Layer: Web UI. Props only: callers pass the node catalog and any per-node extras, so the
//        picker never reads a store or wakes a node.

import type { NodeCatalogEntry } from "@ryco/client-runtime/state/nodes";
import type { EnvironmentId } from "@ryco/contracts";
import { useId, useMemo, useState } from "react";

import { CheckIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { rovingRadioGroup } from "../ui/roving-radio-group";
import { NodePathText } from "./NodePathText";
import {
  nodeMachineKind,
  nodeStatusLine,
  nodeSummaryParts,
  nodeTone,
  resolveNodePickerAvailability,
  type NodePickerExtrasMap,
  type NodePresenceTone,
  type NodePickerRequirements,
  type NodeTone,
} from "@ryco/client-runtime/projectCopy/nodePicker";

const NODE_TONE_CLASS: Record<NodeTone, string> = {
  info: "text-info bg-info/16 dark:bg-info/24",
  teal: "text-teal-600 bg-teal-600/14 dark:text-teal-400 dark:bg-teal-400/24",
  amber: "text-amber-600 bg-amber-600/14 dark:text-amber-400 dark:bg-amber-400/24",
  purple: "text-purple-600 bg-purple-600/14 dark:text-purple-400 dark:bg-purple-400/24",
  rose: "text-rose-600 bg-rose-600/14 dark:text-rose-400 dark:bg-rose-400/24",
  lime: "text-lime-600 bg-lime-600/14 dark:text-lime-400 dark:bg-lime-400/24",
};

const NODE_BADGE_SIZE_CLASS = {
  sm: "size-4 rounded-[5px] [&_svg]:size-2.5",
  md: "size-5 rounded-[6px] [&_svg]:size-3",
  lg: "size-[34px] rounded-[9px] [&_svg]:size-[18px]",
} as const;

/**
 * A node's machine icon on its colour tile, the mark that stands for the node in
 * pickers, chips and project rows. Offline nodes go grey.
 */
export function NodeBadge(props: {
  readonly node: Pick<
    NodeCatalogEntry,
    "environmentId" | "isThisDevice" | "iconKind" | "platformOs" | "label" | "presence"
  >;
  readonly size?: keyof typeof NODE_BADGE_SIZE_CLASS;
  readonly className?: string | undefined;
}) {
  const { node } = props;
  return (
    <span
      aria-hidden
      data-node-tone={nodeTone(node)}
      className={cn(
        "inline-grid shrink-0 place-items-center transition-[filter,opacity] duration-(--app-motion-duration-chip)",
        NODE_TONE_CLASS[nodeTone(node)],
        NODE_BADGE_SIZE_CLASS[props.size ?? "sm"],
        node.presence === "offline" && "opacity-50 grayscale",
        props.className,
      )}
    >
      <EnvironmentMachineIcon kind={nodeMachineKind(node)} />
    </span>
  );
}

/** The small pill a node's "this device" (or similar) tag uses. */
function NodeTag(props: { readonly children: string }) {
  return (
    <span className="whitespace-nowrap rounded-full bg-muted px-1.5 py-px font-medium text-[10.5px] text-muted-foreground">
      {props.children}
    </span>
  );
}

const ALL_NODES_VALUE = "\u0000all-nodes";

export interface NodePickerProps {
  readonly nodes: ReadonlyArray<NodeCatalogEntry>;
  /** Per-node project counts, path hints and caller-specific disabled reasons. */
  readonly extras?: NodePickerExtrasMap | undefined;
  readonly value: EnvironmentId | null;
  readonly onValueChange: (environmentId: EnvironmentId) => void;
  /** `card` for a dialog's node step; `chip` for compact filters and inline choices. */
  readonly variant?: "card" | "chip";
  readonly requirements?: NodePickerRequirements | undefined;
  /**
   * Chip variant only: an "All" chip ahead of the nodes, checked while `value` is
   * null (a filter across every node).
   */
  readonly allOption?:
    | {
        readonly label?: string;
        readonly count?: number | null;
        readonly onSelect: () => void;
      }
    | null
    | undefined;
  readonly "aria-label"?: string | undefined;
  /** The clock "offline since 09:05" is measured against; defaults to now. */
  readonly nowMs?: number | undefined;
  readonly className?: string | undefined;
}

/**
 * A radio group of nodes. Arrow keys, Home and End move between the selectable
 * ones and select them; disabled nodes are skipped but stay visible with their
 * reason (card text, chip tooltip).
 */
export function NodePicker(props: NodePickerProps) {
  const { nodes, extras, value, onValueChange, variant = "card", allOption } = props;
  const requireMutate = props.requirements?.requireMutate;
  const allowOffline = props.requirements?.allowOffline;
  const requireProjectCopy = props.requirements?.requireProjectCopy;
  const reasonIdPrefix = useId();
  // "offline since 09:05" is measured once per mount; a picker is open for moments.
  const [mountedAtMs] = useState(() => Date.now());
  const nowMs = props.nowMs ?? mountedAtMs;
  const rows = useMemo(
    () =>
      nodes.map((node) => {
        const nodeExtras = extras?.[node.environmentId];
        return {
          node,
          extras: nodeExtras,
          availability: resolveNodePickerAvailability(
            node,
            { requireMutate, allowOffline, requireProjectCopy },
            nodeExtras,
          ),
        };
      }),
    [allowOffline, extras, nodes, requireMutate, requireProjectCopy],
  );
  const withAll = variant === "chip" && allOption ? allOption : null;
  const group = rovingRadioGroup<string>({
    options: [
      ...(withAll ? [{ value: ALL_NODES_VALUE }] : []),
      ...rows.map((row) => ({
        value: row.node.environmentId,
        disabled: !row.availability.selectable,
      })),
    ],
    value: value ?? (withAll ? ALL_NODES_VALUE : null),
    onChange: (next) => {
      if (next === ALL_NODES_VALUE) {
        withAll?.onSelect();
        return;
      }
      onValueChange(next as EnvironmentId);
    },
  });

  if (variant === "chip") {
    return (
      <div
        role="radiogroup"
        aria-label={props["aria-label"] ?? "Nodes"}
        onKeyDown={group.onKeyDown}
        data-slot="node-picker"
        data-variant="chip"
        className={cn("flex gap-1 overflow-x-auto [scrollbar-width:none]", props.className)}
      >
        {withAll ? (
          <button
            {...group.radio(ALL_NODES_VALUE)}
            className={cn(
              CHIP_CLASS,
              "ps-[9px]",
              value === null && "border-border bg-foreground/10 text-foreground",
            )}
          >
            {withAll.label ?? "All"}
            {typeof withAll.count === "number" ? (
              <span className="opacity-55">{withAll.count}</span>
            ) : null}
          </button>
        ) : null}
        {rows.map(({ node, extras: nodeExtras, availability }) => {
          const status = nodeStatusLine(node, nowMs);
          const reasonId = `${reasonIdPrefix}-${node.environmentId}`;
          const title =
            availability.reason ?? [status.os, status.presence].filter(Boolean).join(" · ");
          const checked = value === node.environmentId;
          return (
            <button
              key={node.environmentId}
              {...group.radio(node.environmentId)}
              title={title}
              aria-describedby={availability.reason ? reasonId : undefined}
              className={cn(
                CHIP_CLASS,
                checked && "border-border bg-foreground/10 text-foreground",
              )}
            >
              <NodeBadge node={node} size="sm" />
              {node.label}
              {typeof nodeExtras?.projectCount === "number" ? (
                <span className="opacity-55">{nodeExtras.projectCount}</span>
              ) : null}
              {availability.reason ? (
                <span id={reasonId} className="sr-only">
                  {availability.reason}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label={props["aria-label"] ?? "Nodes"}
      onKeyDown={group.onKeyDown}
      data-slot="node-picker"
      data-variant="card"
      className={cn("grid grid-cols-1 gap-2.5 sm:grid-cols-2", props.className)}
    >
      {rows.map(({ node, extras: nodeExtras, availability }) => {
        const status = nodeStatusLine(node, nowMs);
        // An offline node's presence line already says why; it keeps its summary.
        const reasonInSummary = availability.reason !== null && !availability.reasonIsPresence;
        const summary = reasonInSummary
          ? ({ kind: "detail", text: availability.reason } as const)
          : nodeSummaryParts(nodeExtras);
        const reasonId = `${reasonIdPrefix}-${node.environmentId}`;
        return (
          <button
            key={node.environmentId}
            {...group.radio(node.environmentId)}
            title={availability.reason ?? undefined}
            aria-describedby={availability.reason ? reasonId : undefined}
            className={cn(
              "group/node relative flex min-w-0 cursor-pointer items-start gap-3 rounded-xl border border-border p-3.5 text-left outline-none",
              "transition-[border-color,background-color,box-shadow,opacity] duration-(--app-motion-duration-chip) ease-(--app-motion-ease)",
              "hover:not-disabled:border-foreground/20 hover:not-disabled:bg-accent/50",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              "data-checked:border-primary data-checked:shadow-[0_0_0_1px_var(--primary)]",
              "disabled:cursor-not-allowed disabled:opacity-55",
            )}
          >
            <span className="relative shrink-0">
              <NodeBadge node={node} size="lg" />
              <PresenceDot tone={status.tone} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-1.5 pe-5">
                <span className="truncate font-medium text-[13.5px] text-foreground leading-5">
                  {node.label}
                </span>
                {node.isThisDevice ? <NodeTag>this device</NodeTag> : null}
              </span>
              <span
                id={availability.reasonIsPresence ? reasonId : undefined}
                className="truncate text-[12px] text-muted-foreground"
              >
                {status.os ? `${status.os} · ` : null}
                <span
                  className={cn(
                    status.tone === "online" && "text-success-foreground dark:text-success",
                    status.tone === "connecting" && "text-warning-foreground",
                  )}
                >
                  {status.presence}
                </span>
              </span>
              {summary ? (
                <span
                  id={reasonInSummary ? reasonId : undefined}
                  className="mt-1 flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground"
                  data-slot="node-summary"
                >
                  {summary.kind === "detail" ? (
                    <span className="truncate">{summary.text}</span>
                  ) : (
                    <>
                      {summary.projects !== null ? (
                        <span className="shrink-0">{summary.projects}</span>
                      ) : null}
                      {summary.projects !== null && summary.roots !== null ? (
                        <span aria-hidden className="shrink-0 opacity-50">
                          ·
                        </span>
                      ) : null}
                      {summary.roots !== null ? (
                        <NodePathText
                          path={summary.roots}
                          className="flex-1 font-mono text-[11px]"
                        />
                      ) : null}
                    </>
                  )}
                </span>
              ) : null}
            </span>
            <span
              aria-hidden
              className="absolute end-3 top-3 grid size-4 place-items-center rounded-full bg-primary text-primary-foreground opacity-0 transition-opacity duration-(--app-motion-duration-chip) group-data-checked/node:opacity-100"
            >
              <CheckIcon className="size-2.5" strokeWidth={3} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A node's presence as a dot on its badge's corner: online, connecting, or offline. */
function PresenceDot(props: { readonly tone: NodePresenceTone }) {
  return (
    <span
      aria-hidden
      data-presence={props.tone}
      className={cn(
        "absolute -end-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-popover",
        props.tone === "online" && "bg-success",
        props.tone === "connecting" && "bg-warning",
        props.tone === "offline" && "bg-muted-foreground/60",
      )}
    />
  );
}

const CHIP_CLASS = cn(
  "inline-flex shrink-0 cursor-pointer items-center gap-[5px] whitespace-nowrap rounded-full border border-transparent py-[3px] ps-1 pe-2 text-[11.5px] text-muted-foreground outline-none",
  "transition-[background-color,border-color,color,opacity] duration-(--app-motion-duration-chip) ease-(--app-motion-ease)",
  "hover:not-disabled:bg-accent/60 hover:not-disabled:text-foreground",
  "focus-visible:ring-2 focus-visible:ring-ring",
  "disabled:cursor-not-allowed disabled:opacity-50",
);
