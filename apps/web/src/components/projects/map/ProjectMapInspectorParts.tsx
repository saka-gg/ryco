import type {
  ThreadLifecycleActionId,
  WorkspaceActionId,
} from "@ryco/client-runtime/state/lifecycle";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  FolderMinusIcon,
  FolderPlusIcon,
  OctagonPauseIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../../lib/utils";
import type { MapCheckoutDetail } from "./useProjectMapCheckouts";

/** The small pieces every inspector panel is built from, so panels read alike. */

export const ACTION_ICONS: Record<WorkspaceActionId, typeof ArchiveIcon> = {
  archive: ArchiveIcon,
  restore: ArchiveRestoreIcon,
  "recreate-checkout": FolderPlusIcon,
  "remove-stale-record": FolderMinusIcon,
  "remove-checkout": FolderMinusIcon,
  "delete-workspace": Trash2Icon,
};

export const THREAD_ACTION_ICONS: Record<ThreadLifecycleActionId, typeof ArchiveIcon> = {
  "interrupt-turn": OctagonPauseIcon,
  "stop-session": SquareIcon,
  archive: ArchiveIcon,
  unarchive: ArchiveRestoreIcon,
  trash: Trash2Icon,
};

export function Kind(props: { readonly icon: ReactNode; readonly children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
      {props.icon}
      {props.children}
    </div>
  );
}

export function Title(props: { readonly mono?: boolean; readonly children: ReactNode }) {
  return (
    <h3
      className={cn(
        "mt-1.5 mr-7 break-words text-[15px] font-semibold tracking-tight",
        props.mono && "font-mono text-[14px] font-medium",
      )}
    >
      {props.children}
    </h3>
  );
}

export function Facts(props: { readonly rows: ReadonlyArray<readonly [string, ReactNode]> }) {
  return (
    <dl className="mt-3.5 grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
      {props.rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Section(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="mt-4 border-t border-border/60 pt-3">
      <h4 className="mb-1.5 text-[11px] font-medium text-muted-foreground">{props.title}</h4>
      <div className="-mx-2 flex flex-col">{props.children}</div>
    </section>
  );
}

export const LINK_ROW_CLASS =
  "flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-left text-[12.5px] outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";

export function LinkRow(props: {
  readonly onClick: () => void;
  readonly icon: ReactNode;
  readonly children: ReactNode;
  readonly trailing?: ReactNode;
}) {
  return (
    <button type="button" onClick={props.onClick} className={LINK_ROW_CLASS}>
      {props.icon}
      <span className="min-w-0 flex-1 truncate">{props.children}</span>
      {props.trailing}
    </button>
  );
}

export function Actions(props: {
  readonly children: ReactNode;
  readonly disabledReason?: string | null;
}) {
  return (
    <>
      <div className="mt-4 flex flex-wrap gap-1.5">{props.children}</div>
      {props.disabledReason ? (
        <p className="mt-2 text-[11.5px] text-muted-foreground">{props.disabledReason}</p>
      ) : null}
    </>
  );
}

export const findDetail = (details: readonly MapCheckoutDetail[], key: string) =>
  details.find((detail) => detail.checkout.key === key) ?? null;
