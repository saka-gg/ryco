import { createFileRoute, redirect } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

import { AppBootLoadingSurface } from "../components/AppBootLoadingSurface";
import type { WorkspacesSearch } from "../components/workspaces/WorkspacesPage";
import { getPresentationTier } from "../lib/presentationTier";

const LazyWorkspacesPage = lazy(() =>
  import("../components/workspaces/WorkspacesPage").then((module) => ({
    default: module.WorkspacesPage,
  })),
);

function parseWorkspacesSearch(search: Record<string, unknown>): WorkspacesSearch {
  return {
    ...(typeof search.environmentId === "string" ? { environmentId: search.environmentId } : {}),
    ...(typeof search.projectId === "string" ? { projectId: search.projectId } : {}),
  };
}

function WorkspacesRouteView() {
  // The generated file-route registration validates this shape at runtime.
  // The assertion breaks the component/Route declaration inference cycle.
  const search = Route.useSearch() as WorkspacesSearch;
  const navigate = Route.useNavigate();
  return (
    <Suspense fallback={<AppBootLoadingSurface />}>
      <LazyWorkspacesPage
        search={search}
        onSearchChange={(next) => void navigate({ search: next, replace: true })}
      />
    </Suspense>
  );
}

export const Route = createFileRoute("/workspaces")({
  beforeLoad: ({ context }) => {
    // The frozen web phone tier is not extended; the native app owns phone management.
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
  validateSearch: (search) => parseWorkspacesSearch(search),
  component: WorkspacesRouteView,
});
