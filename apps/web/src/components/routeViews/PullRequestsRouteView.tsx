import { getRouteApi } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { PullRequestsPage } from "../pullRequests/PullRequestsPage";
import type { PullRequestsSearch } from "../pullRequests/pullRequestsSearch";

const pullRequestsRouteApi = getRouteApi("/pull-requests");

/** The `/pull-requests` route body, loaded by the route file through `lazyRouteComponent`. */
export function PullRequestsRoute(): ReactElement {
  // The generated file-route registration validates this shape at runtime.
  // The assertion breaks the lazy component/Route declaration inference cycle.
  const search = pullRequestsRouteApi.useSearch() as PullRequestsSearch;
  const navigate = pullRequestsRouteApi.useNavigate();
  return (
    <PullRequestsPage
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
  );
}
