import { Sheet, SheetPopup } from "../ui/sheet";
import { PROJECTS_FOCUS_ANCHOR_ATTRIBUTE, ProjectDetail } from "./detail/ProjectDetail";
import { ProjectListPane } from "./list/ProjectListPane";
import { useProjectsLayoutStore } from "./projectsLayoutStore";
import { PROJECTS_LIST_WIDTH, useProjectsPage } from "./ProjectsPageContext";

/** Where focus goes when the drawer closes: its opener, else the detail's scroll region. */
function drawerFinalFocus(): HTMLElement | boolean {
  const opener = useProjectsLayoutStore.getState().drawerOpener;
  if (opener?.isConnected) return opener;
  return document.querySelector<HTMLElement>(`[${PROJECTS_FOCUS_ANCHOR_ATTRIBUTE}]`) ?? true;
}

/**
 * The page under the providers: the list (docked column, drawer, or the whole
 * page) and the detail. Split from `ProjectsPage` so tests render the exact
 * shell inside `ProjectsTestProvider`.
 */
export function ProjectsPageBody() {
  const { layout } = useProjectsPage();
  if (layout.listFillsPage) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ProjectListPane variant="fill" />
      </div>
    );
  }
  return (
    <>
      {layout.listDocked ? (
        <aside
          aria-label="Projects"
          className="relative flex min-h-0 shrink-0 flex-col border-r border-border/70"
          style={{ width: PROJECTS_LIST_WIDTH }}
        >
          <ProjectListPane variant="docked" />
        </aside>
      ) : null}
      {/* SidebarInset is already the page's <main>. */}
      <div className="@container/detail flex min-h-0 min-w-0 flex-1 flex-col">
        <ProjectDetail />
      </div>
      {!layout.listDocked ? (
        <Sheet
          open={layout.drawerOpen}
          onOpenChange={(open) => (open ? layout.openDrawer() : layout.closeDrawer())}
        >
          <SheetPopup
            side="left"
            aria-label="Projects"
            showCloseButton={false}
            finalFocus={drawerFinalFocus}
            className="w-[min(22rem,calc(100%-3rem))] max-w-none p-0"
          >
            <ProjectListPane variant="drawer" />
          </SheetPopup>
        </Sheet>
      ) : null}
    </>
  );
}
