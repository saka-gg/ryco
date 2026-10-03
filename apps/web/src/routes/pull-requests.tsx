import { createFileRoute, redirect } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

import { AppBootLoadingSurface } from "../components/AppBootLoadingSurface";
import {
  parsePullRequestsSearch,
  type PullRequestsSearch,
} from "../components/pullRequests/pullRequestsSearch";
import { getPresentationTier } from "../lib/presentationTier";

const LazyPullRequestsPage = lazy(() =>
  import("../components/pullRequests/PullRequestsPage").then((module) => ({
    default: module.PullRequestsPage,
  })),
);

function PullRequestsRouteView() {
  // The generated file-route registration validates this shape at runtime.
  // The assertion breaks the component/Route declaration inference cycle.
  const search = Route.useSearch() as PullRequestsSearch;
  const navigate = Route.useNavigate();
  return (
    <Suspense fallback={<AppBootLoadingSurface />}>
      <LazyPullRequestsPage
        search={search}
        onSearchChange={(next, options) =>
          void navigate({
            search: next,
            replace: options?.replace ?? true,
            ...(options?.viewTransitionTypes
              ? { viewTransition: { types: [...options.viewTransitionTypes] } }
              : {}),
          })
        }
      />
    </Suspense>
  );
}

export const Route = createFileRoute("/pull-requests")({
  beforeLoad: ({ context }) => {
    // The web phone tier is frozen; pull requests live in the native app there.
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
  validateSearch: (search) => parsePullRequestsSearch(search),
  component: PullRequestsRouteView,
});
