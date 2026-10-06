import { createFileRoute, redirect } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

import { parseProjectsSearch, type ProjectsSearch } from "../components/projects/projectsSearch";
import { SidebarInset } from "../components/ui/sidebar";
import { getPresentationTier } from "../lib/presentationTier";

const LazyProjectsPage = lazy(() =>
  import("../components/projects/ProjectsPage").then((module) => ({
    default: module.ProjectsPage,
  })),
);

function ProjectsRouteView() {
  // The generated file-route registration validates this shape at runtime.
  // The assertion breaks the component/Route declaration inference cycle.
  const search = Route.useSearch() as ProjectsSearch;
  const navigate = Route.useNavigate();
  return (
    // A blank inset, not the boot logo: the page shell paints in one frame.
    <Suspense
      fallback={
        <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground" />
      }
    >
      <LazyProjectsPage
        search={search}
        onSearchChange={(next, options) =>
          void navigate({ search: next, replace: options?.replace ?? true })
        }
      />
    </Suspense>
  );
}

export const Route = createFileRoute("/projects")({
  beforeLoad: ({ context }) => {
    // The web phone tier is frozen; it keeps the project dialogs instead.
    if (getPresentationTier() === "phone") {
      throw redirect({ to: "/", replace: true });
    }
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static" &&
      context.authGateState.status !== "hosted-hub"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  validateSearch: (search) => parseProjectsSearch(search),
  component: ProjectsRouteView,
});
