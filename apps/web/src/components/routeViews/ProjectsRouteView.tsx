import { getRouteApi } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { ProjectsPage } from "../projects/ProjectsPage";
import type { ProjectsSearch } from "../projects/projectsSearch";

const projectsRouteApi = getRouteApi("/projects");

/** The `/projects` route body, loaded by the route file through `lazyRouteComponent`. */
export function ProjectsRoute(): ReactElement {
  // The generated file-route registration validates this shape at runtime.
  // The assertion breaks the lazy component/Route declaration inference cycle.
  const search = projectsRouteApi.useSearch() as ProjectsSearch;
  const navigate = projectsRouteApi.useNavigate();
  return (
    <ProjectsPage
      search={search}
      onSearchChange={(next, options) =>
        void navigate({ search: next, replace: options?.replace ?? true })
      }
    />
  );
}
