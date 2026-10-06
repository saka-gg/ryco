import { cn } from "../../../lib/utils";
import { useActiveIndicator } from "../../ui/useActiveIndicator";
import type { ProjectSection } from "../projectsSearch";
import {
  PROJECT_SECTION_GROUPS,
  PROJECT_SECTION_LABELS,
  projectSectionId,
} from "../sections/projectSectionTypes";

/**
 * The page's table of contents, beside the sections on a wide detail. One
 * plate travels to the section being read, so scrolling and jumping both read
 * as motion; links keep their real anchors for middle-click and copy.
 */
export function ProjectSectionNav(props: {
  readonly sections: readonly ProjectSection[];
  readonly active: ProjectSection | null;
  readonly onSelect: (section: ProjectSection) => void;
}) {
  const { listRef, rect, animate } = useActiveIndicator(props.active);
  const visible = new Set(props.sections);
  return (
    <nav
      aria-label="Project sections"
      className="sticky top-8 w-44 shrink-0 self-start pt-8 [-webkit-app-region:no-drag]"
    >
      <div ref={listRef} className="relative isolate flex flex-col">
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 -z-10 rounded-[min(var(--radius-md),0.5rem)] bg-accent",
            animate &&
              "transition-[transform,height,opacity] duration-(--app-motion-duration-stack) ease-(--app-motion-spring-gentle) motion-reduce:transition-none",
            rect ? "opacity-100" : "opacity-0",
          )}
          style={{
            top: 0,
            height: rect?.height ?? 0,
            transform: `translateY(${rect?.top ?? 0}px)`,
          }}
        />
        {PROJECT_SECTION_GROUPS.map((group, groupIndex) => {
          const items = group.sections.filter((section) => visible.has(section));
          if (items.length === 0) return null;
          return (
            <div
              key={group.label ?? `group-${groupIndex}`}
              role="group"
              aria-label={group.label ?? undefined}
              className={cn("flex flex-col gap-px", groupIndex > 0 && "mt-4")}
            >
              {group.label ? (
                <div className="flex h-6 items-center px-2.5 text-[11px] font-medium text-muted-foreground/80">
                  {group.label}
                </div>
              ) : null}
              {items.map((section) => {
                const current = section === props.active;
                return (
                  <a
                    key={section}
                    href={`#${projectSectionId(section)}`}
                    data-nav-key={section}
                    aria-current={current ? "location" : undefined}
                    onClick={(event) => {
                      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
                        return;
                      }
                      event.preventDefault();
                      props.onSelect(section);
                    }}
                    className={cn(
                      "flex h-7 items-center rounded-[min(var(--radius-md),0.5rem)] px-2.5 text-[13px] outline-hidden transition-colors duration-(--app-motion-duration-chip) focus-visible:ring-2 focus-visible:ring-ring",
                      current
                        ? "font-medium text-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                      section === "danger" && !current && "text-destructive-foreground/80",
                    )}
                  >
                    <span className="min-w-0 truncate">{PROJECT_SECTION_LABELS[section]}</span>
                  </a>
                );
              })}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
