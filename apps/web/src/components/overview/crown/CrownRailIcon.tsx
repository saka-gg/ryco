import { CheckRing } from "./CheckRing";
import { CrownBadge } from "./CrownBadge";
import type { CrownRailSummary } from "./crownModel.logic";
import type { CrownRailItem } from "./crownSections";
import { PlanArc } from "./PlanArc";

/** Per-icon state attributes the stylesheet colours by (prototype `syncRailIcons`). */
export function crownRailIconState(
  item: CrownRailItem,
  summary: CrownRailSummary,
): Record<`data-${string}`, string | undefined> {
  switch (item.key) {
    case "checks":
      return { "data-ci": summary.checks.ci };
    case "agents":
      return { "data-live": summary.agents.live > 0 ? "true" : undefined };
    case "pr":
      return {
        "data-state": summary.pr.conflict ? "conflict" : (summary.pr.state ?? "none"),
      };
    case "ship":
      return { "data-ready": summary.ship.ready ? "true" : undefined };
    default:
      return {};
  }
}

/** The corner badge or status dot an icon glyph carries (prototype `setBadge` / live dot). */
function IconAccessory(props: {
  readonly item: CrownRailItem;
  readonly summary: CrownRailSummary;
}) {
  const { item, summary } = props;
  switch (item.key) {
    case "agents":
      return (
        <>
          <i aria-hidden="true" className="crown-live-dot" />
          <CrownBadge value={summary.agents.count} />
        </>
      );
    case "branch":
      return <CrownBadge value={summary.branch.badge} />;
    case "changes":
      return <CrownBadge value={summary.changes.count} />;
    case "notes":
      return <CrownBadge value={summary.notes.count} variant="note" />;
    case "ship":
      return <CrownBadge value={summary.ship.count} variant="info" />;
    default:
      return null;
  }
}

/**
 * A rail button's glyph stack (prototype `railGlyph`): the glyph the registry
 * names (the icon, or its live graphic: CI ring, plan arc) plus the corner
 * badge and status dots. Every layer shares one grid cell so they overlap.
 */
export function CrownRailIcon(props: {
  readonly item: CrownRailItem;
  readonly summary: CrownRailSummary;
}) {
  const { item, summary } = props;
  const Icon = item.icon;
  switch (item.glyph) {
    case "checkRing":
      return (
        <>
          <CheckRing
            segments={summary.checks.segments}
            viewBox={32}
            radius={12.5}
            className="crown-rail-ring"
          />
          <i aria-hidden="true" className="crown-ci-dot" />
        </>
      );
    case "planArc":
      return <PlanArc pct={summary.plan.pct} />;
    case "icon":
      return (
        <>
          <Icon aria-hidden="true" className="crown-rail-glyph" />
          <IconAccessory item={item} summary={summary} />
        </>
      );
  }
}
