/**
 * Test-only: renders the real `ProjectsPage` (data wiring included) over
 * in-memory URL state, inside a fixed-size frame. Seed the app store with
 * `seedProjectsFixtureStore` first. Components that navigate to other routes
 * call `useNavigate`, so tests mock `@tanstack/react-router`:
 *
 *   const navigate = vi.fn();
 *   vi.mock("@tanstack/react-router", async (importOriginal) => ({
 *     ...(await importOriginal<typeof import("@tanstack/react-router")>()),
 *     useNavigate: () => navigate,
 *   }));
 *
 * Every search change is recorded in `projectsTestSearchLog`.
 */
import { useState, type CSSProperties } from "react";

import { AppAtomRegistryProvider } from "../../../rpc/atomRegistry";
import { SidebarProvider } from "../../ui/sidebar";
import { ProjectsPage } from "../ProjectsPage";
import type { ProjectsSearch } from "../projectsSearch";

export const projectsTestSearchLog: {
  readonly entries: Array<{ readonly search: ProjectsSearch; readonly replace: boolean }>;
  last: () => ProjectsSearch | undefined;
  clear: () => void;
} = {
  entries: [],
  last() {
    return this.entries.at(-1)?.search;
  },
  clear() {
    this.entries.length = 0;
  },
};

export function ProjectsTestHarness(props: {
  readonly initialSearch?: ProjectsSearch;
  readonly width?: number;
  readonly height?: number;
  readonly sidebarCollapsed?: boolean;
}) {
  const [search, setSearch] = useState<ProjectsSearch>(props.initialSearch ?? {});
  const frameStyle: CSSProperties = { width: props.width ?? 1200, height: props.height ?? 800 };
  return (
    <AppAtomRegistryProvider>
      <SidebarProvider
        open={!props.sidebarCollapsed}
        onOpenChange={() => undefined}
        className="min-h-0 w-auto"
      >
        <div data-testid="projects-test-root" className="flex" style={frameStyle}>
          <ProjectsPage
            search={search}
            onSearchChange={(next, options) => {
              projectsTestSearchLog.entries.push({
                search: next,
                replace: options?.replace ?? true,
              });
              setSearch(next);
            }}
          />
        </div>
      </SidebarProvider>
    </AppAtomRegistryProvider>
  );
}
