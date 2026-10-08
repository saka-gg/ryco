import { Fragment, useState, type MouseEvent, type PointerEvent, type Ref } from "react";

import { cn } from "~/lib/utils";

import { useActiveIndicator } from "../../ui/useActiveIndicator";
import { crownRailItemDescription, type CrownRailSummary } from "./crownModel.logic";
import type { CrownRailItem, CrownRailKey } from "./crownSections";
import { CrownPing } from "./CrownPing";
import { crownRailIconState, CrownRailIcon } from "./CrownRailIcon";
import type { CrownPings } from "./useCrownAlerts";

function railKeyOf(target: EventTarget, list: HTMLElement): [CrownRailKey, HTMLElement] | null {
  if (!(target instanceof Element)) return null;
  const button = target.closest<HTMLElement>("[data-nav-key]");
  if (!button || !list.contains(button)) return null;
  return [button.dataset.navKey as CrownRailKey, button];
}

/**
 * The icon column (prototype `railNavHTML`), shared by the docked rail and the
 * card's spine. One highlight circle slides to the active button: the hovered
 * icon on the rail, the selected section on the spine.
 */
export function CrownRailNav({
  ref,
  ...props
}: {
  readonly variant: "rail" | "spine";
  readonly items: ReadonlyArray<CrownRailItem>;
  readonly summary: CrownRailSummary;
  readonly pings: CrownPings;
  readonly activeKey: CrownRailKey | null;
  readonly onItemClick: (key: CrownRailKey, button: HTMLElement, event: MouseEvent) => void;
  readonly onItemPointerOver?: (key: CrownRailKey, button: HTMLElement) => void;
  readonly onPointerLeave?: () => void;
  readonly inert?: boolean;
  readonly className?: string;
  readonly ref?: Ref<HTMLElement>;
}) {
  const { variant, items, summary, pings, activeKey, onItemClick, onItemPointerOver } = props;
  const { listRef, rect, animate } = useActiveIndicator(activeKey);
  // The highlight fades out in place rather than jumping back to the top.
  const [lastRect, setLastRect] = useState(rect);
  if (rect && rect !== lastRect) setLastRect(rect);

  const handlePointerOver = (event: PointerEvent<HTMLDivElement>) => {
    if (!onItemPointerOver) return;
    const hit = railKeyOf(event.target, event.currentTarget);
    if (hit) onItemPointerOver(hit[0], hit[1]);
  };

  return (
    <nav
      ref={ref}
      aria-label={variant === "rail" ? "Overview" : "Overview sections"}
      data-slot={variant === "rail" ? "crown-rail" : "crown-spine"}
      className={cn(
        "crown-rail-nav",
        variant === "rail" ? "crown-rail crown-mat" : "crown-spine",
        props.className,
      )}
      inert={props.inert || undefined}
      onPointerLeave={props.onPointerLeave}
    >
      <div
        ref={listRef}
        className="relative flex flex-col items-center gap-[5px] p-1.5"
        onPointerOver={handlePointerOver}
      >
        <span
          aria-hidden="true"
          className="crown-rail-hl"
          data-animate={animate ? "true" : undefined}
          style={{
            opacity: rect ? 1 : 0,
            transform: `translateY(${(rect ?? lastRect)?.top ?? 0}px)`,
          }}
        />
        {items.map((item, index) => {
          const previous = items[index - 1];
          const active = item.key === activeKey;
          return (
            <Fragment key={item.key}>
              {previous && previous.group !== item.group ? (
                <span aria-hidden="true" className="crown-rail-sep" />
              ) : null}
              <button
                type="button"
                aria-label={item.label}
                aria-description={crownRailItemDescription(item, summary) ?? undefined}
                aria-current={variant === "spine" && active ? "true" : undefined}
                className="crown-rail-btn"
                data-nav-key={item.key}
                data-active={active ? "true" : undefined}
                {...crownRailIconState(item, summary)}
                onClick={(event) => onItemClick(item.key, event.currentTarget, event)}
              >
                <CrownRailIcon item={item} summary={summary} />
                <CrownPing ping={pings[item.key]} />
              </button>
            </Fragment>
          );
        })}
      </div>
    </nav>
  );
}
