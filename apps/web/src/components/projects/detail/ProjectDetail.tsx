import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { isElectron } from "../../../env";
import { useHandOffFocusOnUnmount, takePageFocusHandoff } from "../../../hooks/usePageFocusHandoff";
import { readMotionDurationMs } from "../../../lib/perf/motion";
import { cn } from "../../../lib/utils";
import { retainDesktopWorkspaceInteractiveScope } from "../../../platform/desktopWorkspace";
import { SettingsNotice } from "../../settings/settingsLayout";
import { useProjectsPage, useProjectsSelection } from "../ProjectsPageContext";
import type { ProjectSection } from "../projectsSearch";
import { PROJECT_SECTION_COMPONENTS } from "../sections/projectSectionComponents";
import { visibleProjectSections, type ProjectSectionProps } from "../sections/projectSectionTypes";
import { useProjectEditAccess } from "../sections/useProjectEditAccess";
import { ringOnce } from "./landing";
import { ProjectMap } from "../map/ProjectMap";
import { resolveProjectsView } from "../projectsSearch";
import { ProjectBar } from "./ProjectBar";
import { ProjectDetailContext, type ProjectDetailContextValue } from "./ProjectDetailContext";
import { ProjectDetailStatus } from "./ProjectDetailStatus";
import { ProjectHero } from "./ProjectHero";
import { ProjectSectionNav } from "./ProjectSectionNav";
import { useProjectSectionSpy } from "./useProjectSectionSpy";

/** Marks the detail's scroll region: focus lands here after `j`/`k` and the drawer. */
export const PROJECTS_FOCUS_ANCHOR_ATTRIBUTE = "data-projects-focus-anchor";

function prefersMotion(): boolean {
  return readMotionDurationMs("--app-motion-duration-pop", 200) > 0;
}

/**
 * The project's page: one scroll of everything that can be changed about the
 * checkout, the hero first, then the sections in navigation order. It is
 * keyed by the logical project, so a project change remounts it and it
 * settles in from the direction of travel through the list.
 */
function ProjectDetailBody() {
  const { selectionMotion, nav, layout, primaryEnvironmentId } = useProjectsPage();
  const { member, checkoutKey } = useProjectsSelection();
  // Captured at mount: the settle plays once, in the direction we arrived from.
  const [motion] = useState(selectionMotion);
  const animate = motion.token > 0 && prefersMotion();
  const [heroInView, setHeroInView] = useState(false);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);

  // Writes follow the checkout's access (role on its device, reachability).
  const access = useProjectEditAccess(member.environmentId);
  const sections = useMemo(
    () => visibleProjectSections({ canManageNode: access.canManageNode }),
    [access.canManageNode],
  );
  const spy = useProjectSectionSpy(scrollElement, sections);
  const { pin } = spy;

  const scrollToSection = useCallback(
    (section: ProjectSection, options: { readonly smooth: boolean; readonly focus: boolean }) => {
      const element = scrollElement?.querySelector<HTMLElement>(
        `[data-project-section="${section}"]`,
      );
      if (!element) return false;
      element.scrollIntoView({ block: "start", behavior: options.smooth ? "smooth" : "auto" });
      ringOnce(element, "projects-section-landed");
      if (options.focus) {
        // Keyboard users continue from the section they asked for.
        const heading = element.querySelector<HTMLElement>("h2");
        if (heading) {
          heading.tabIndex = -1;
          heading.focus({ preventScroll: true });
        }
      }
      return true;
    },
    [scrollElement],
  );

  // A section in the URL (a deep link, or one recorded by a reveal) lands
  // once: instantly on arrival, smoothly when the URL changes later. A
  // section that has not mounted yet (node access still resolving) lands
  // when it does.
  const requested = nav.search.section;
  const revealedRef = useRef<ProjectSection | null>(null);
  const landedRef = useRef(false);
  useEffect(() => {
    if (!requested) {
      revealedRef.current = null;
      return;
    }
    if (revealedRef.current === requested || !sections.includes(requested)) return;
    if (
      scrollToSection(requested, { smooth: landedRef.current && prefersMotion(), focus: false })
    ) {
      revealedRef.current = requested;
      landedRef.current = true;
      pin(requested);
    }
  }, [pin, requested, scrollToSection, sections]);

  const { revealSection: recordSection } = nav;
  const context = useMemo<ProjectDetailContextValue>(
    () => ({
      setHeroInView,
      revealSection: (section) => {
        if (!sections.includes(section)) return;
        // From the map there is nothing to scroll yet: record it, and the
        // URL-driven landing scrolls once the settings view has mounted.
        if (scrollToSection(section, { smooth: prefersMotion(), focus: true })) {
          revealedRef.current = section;
          landedRef.current = true;
          pin(section);
        }
        recordSection(section);
      },
    }),
    [pin, recordSection, scrollToSection, sections],
  );

  // `j`/`k` replace this subtree; if it held focus, keep focus in the new one.
  const rootRef = useRef<HTMLDivElement>(null);
  useHandOffFocusOnUnmount(rootRef);
  useLayoutEffect(() => {
    if (!takePageFocusHandoff()) return;
    rootRef.current
      ?.querySelector<HTMLElement>(`[${PROJECTS_FOCUS_ANCHOR_ATTRIBUTE}]`)
      ?.focus({ preventScroll: true });
  }, []);

  // A checkout on another desktop Hub machine connects on demand: hold it
  // while it is on screen, as the settings page does for a remote device.
  const environmentId = member.environmentId;
  useEffect(() => {
    if (!isElectron || environmentId === primaryEnvironmentId) return;
    return retainDesktopWorkspaceInteractiveScope(environmentId);
  }, [environmentId, primaryEnvironmentId]);

  // A checkout change (same project, another device) re-keys the content; it
  // settles in place rather than travelling, and the scroll position stays.
  const [scope, setScope] = useState({ key: checkoutKey, changed: false });
  if (scope.key !== checkoutKey) setScope({ key: checkoutKey, changed: true });

  if (resolveProjectsView(nav.search) === "map") {
    return (
      <ProjectDetailContext.Provider value={context}>
        <div
          ref={rootRef}
          data-project-detail={checkoutKey}
          data-projects-view="map"
          className={cn("flex min-h-0 flex-1 flex-col", animate && "projects-detail-settle")}
          style={{ "--projects-motion-dir": motion.direction } as CSSProperties}
        >
          <ProjectBar heroInView={false} />
          <div
            key="map"
            tabIndex={-1}
            {...{ [PROJECTS_FOCUS_ANCHOR_ATTRIBUTE]: "" }}
            className="projects-view-enter flex min-h-0 flex-1 flex-col outline-hidden"
          >
            <ProjectMap />
          </div>
        </div>
      </ProjectDetailContext.Provider>
    );
  }

  const sectionProps: ProjectSectionProps = {
    member,
    canEdit: access.canEdit,
    canManageNode: access.canManageNode,
  };

  return (
    <ProjectDetailContext.Provider value={context}>
      <div
        ref={rootRef}
        data-project-detail={checkoutKey}
        className={cn("flex min-h-0 flex-1 flex-col", animate && "projects-detail-settle")}
        style={{ "--projects-motion-dir": motion.direction } as CSSProperties}
      >
        <ProjectBar heroInView={heroInView} />
        <div
          key="settings"
          ref={setScrollElement}
          tabIndex={-1}
          {...{ [PROJECTS_FOCUS_ANCHOR_ATTRIBUTE]: "" }}
          className="projects-view-enter min-h-0 flex-1 overflow-y-auto outline-hidden [scrollbar-gutter:stable]"
        >
          <div
            className={cn(
              "mx-auto flex w-full gap-12 px-6 @[48rem]/detail:px-10",
              layout.tocDocked ? "max-w-[62rem]" : "max-w-[46rem]",
            )}
          >
            <div
              key={checkoutKey}
              className={cn("min-w-0 flex-1 pt-8 pb-32", scope.changed && "projects-scope-settle")}
            >
              <ProjectHero canEdit={access.canEdit} />
              {access.reason || access.nodeReason ? (
                <SettingsNotice role="status" className="mt-6">
                  {access.reason ?? access.nodeReason}
                </SettingsNotice>
              ) : null}
              <div className="mt-10 flex flex-col gap-10">
                {sections.map((section) => {
                  const Section = PROJECT_SECTION_COMPONENTS[section];
                  return <Section key={section} {...sectionProps} />;
                })}
              </div>
            </div>
            {layout.tocDocked ? (
              <ProjectSectionNav
                sections={sections}
                active={spy.active}
                onSelect={context.revealSection}
              />
            ) : null}
          </div>
        </div>
      </div>
    </ProjectDetailContext.Provider>
  );
}

export function ProjectDetail() {
  const { selection } = useProjectsPage();
  if (!selection) return <ProjectDetailStatus />;
  return <ProjectDetailBody key={selection.snapshot.projectKey} />;
}
