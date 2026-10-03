import { GitPullRequestIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { RepositoryStatusMessage } from "./list/RepositoryStatusMessage";
import { KeyHint } from "./primitives";
import {
  ListToggleButton,
  PULL_REQUESTS_BAR_CLASS,
  usePullRequestsLeadingInsetClass,
} from "./PullRequestBar";
import { usePullRequestsPage } from "./PullRequestsPageContext";

/**
 * Reader area with nothing selected: a quiet bar (with the list toggle when no
 * list is on screen) and a hint, never a call to action. When the repository
 * itself is missing and no list says so, the reason and a picker live here.
 */
export function PullRequestsEmptyReader() {
  const { layout, repository, repositoryStatus, model } = usePullRequestsPage();
  const insetClass = usePullRequestsLeadingInsetClass(layout.leadingRegion === "reader", "pl-3");
  // A visible list already explains itself (empty, loading, repository
  // status); say each thing once.
  const listShown = layout.listVisible || layout.listFillsPage;
  const status = repositoryStatus.kind === "ready" ? null : repositoryStatus;
  const message =
    status !== null || repository === null
      ? null
      : model.list.isLoading
        ? null
        : model.list.ordered.length === 0
          ? listShown
            ? null
            : "No pull requests match."
          : "Choose a pull request.";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className={cn(PULL_REQUESTS_BAR_CLASS, insetClass, "pr-3")}>
        {listShown ? null : <ListToggleButton />}
      </header>
      {status !== null && !listShown ? (
        <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto">
          <RepositoryStatusMessage status={status} />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <GitPullRequestIcon aria-hidden className="size-5 text-muted-foreground/40" />
          {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
          {model.list.ordered.length > 0 ? (
            <p className="flex items-center gap-3 text-[11px] text-muted-foreground/70">
              <span className="inline-flex items-center gap-1">
                <KeyHint>J</KeyHint>
                <KeyHint>K</KeyHint>
                move
              </span>
              <span className="inline-flex items-center gap-1">
                <KeyHint>/</KeyHint>
                search
              </span>
              <span className="inline-flex items-center gap-1">
                <KeyHint>?</KeyHint>
                shortcuts
              </span>
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
