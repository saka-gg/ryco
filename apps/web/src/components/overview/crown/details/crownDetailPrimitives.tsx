import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import { CROWN_RAIL_ITEMS, CROWN_SECTION_LABEL, type CrownRailItem } from "../crownSections";
import type { CrownSectionDetailProps } from "../crownTypes";

/**
 * Building blocks shared by the Crown section details. Sizes mirror the
 * prototype's detail blocks (`.dh`, `.kv`, `.grp`, `.actions`, `.sub`). The
 * details render inside the forced-dark island, so colours stay on semantic
 * tokens; `text-muted-foreground/60` stands in for the lab's `--faint`.
 */

/** Props every section detail receives (the section is implied by the component). */
export type CrownDetailViewProps = Omit<CrownSectionDetailProps, "section">;

export type CrownDetailSection = CrownSectionDetailProps["section"];

/** The rail item that owns a section (its icon and git requirement). */
export function crownRailItemForSection(section: CrownDetailSection): CrownRailItem | undefined {
  return CROWN_RAIL_ITEMS.find((item) => item.key === section);
}

/** The flyout's heading row (`.dh`); the card titles the section itself, so it renders nothing there. */
export function CrownDetailHeading({
  section,
  variant,
  title,
  meta,
}: {
  section: CrownDetailSection;
  variant: CrownDetailViewProps["variant"];
  /** Overrides the section label (e.g. "PR #683"). */
  title?: ReactNode;
  meta?: ReactNode;
}) {
  if (variant !== "flyout") return null;
  const Icon = crownRailItemForSection(section)?.icon;
  return (
    <div
      className="mb-2.5 flex items-center gap-[7px] text-[12.5px] font-semibold"
      data-slot="crown-detail-heading"
    >
      {Icon ? (
        <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      ) : null}
      <span className="min-w-0 truncate">{title ?? CROWN_SECTION_LABEL[section]}</span>
      {meta !== undefined && meta !== null && meta !== false ? (
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px] font-medium text-muted-foreground tabular-nums">
          {meta}
        </span>
      ) : null}
    </div>
  );
}

export function CrownDetailEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="px-1 py-1 text-[12px] text-muted-foreground" data-slot="crown-detail-empty">
      {children}
    </p>
  );
}

/** A label/value row (`.kv`). */
export function CrownKeyValueRow({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 p-1 text-[12px]">
      <span className="w-[66px] shrink-0 text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 truncate font-medium", className)}>{children}</span>
    </div>
  );
}

/** A file-group header (`.grp`): uppercase label with a count on the right. */
export function CrownGroupHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="mx-1 mt-[9px] mb-[3px] flex justify-between text-[10px] font-semibold tracking-[0.07em] text-muted-foreground/60 uppercase">
      <span>{label}</span>
      <span className="tabular-nums">{count}</span>
    </div>
  );
}

/** The trailing action row (`.actions`); its buttons share the width. */
export function CrownDetailActions({ children }: { children: ReactNode }) {
  return <div className="mt-2.5 flex gap-1.5 *:flex-1">{children}</div>;
}

/** A faint footnote (`.sub`). */
export function CrownDetailFootnote({ children }: { children: ReactNode }) {
  return <p className="mx-1 mt-1.5 truncate text-[11px] text-muted-foreground/60">{children}</p>;
}

/**
 * `className` for a `ui/button` `Button` (variant "ghost", size "sm") styled
 * as the island's pill button (`.crown .btn`): 28px, rounded-full, faint fill
 * and hairline border. Give icons `size-3.5` directly.
 */
export const CROWN_PILL_BUTTON_CLASS =
  "h-7 gap-1.5 rounded-full border-foreground/10 bg-muted px-2.5 text-[12px] font-medium text-foreground transition-[background-color,transform] duration-150 before:rounded-full active:scale-[.97] sm:h-7 sm:text-[12px]";
