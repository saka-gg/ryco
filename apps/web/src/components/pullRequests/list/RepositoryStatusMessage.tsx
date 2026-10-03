import { useId } from "react";

import { usePullRequestsPage, type PullRequestsRepositoryStatus } from "../PullRequestsPageContext";
import { pullRequestRepositoryQualifier } from "../pullRequestRepositories.logic";

/** The sentence for a repository the URL names but the page cannot read (yet). */
export function describeRepositoryStatus(
  status: Exclude<PullRequestsRepositoryStatus, { readonly kind: "ready" }>,
): { readonly title: string; readonly detail: string | null; readonly offerPicker: boolean } {
  const where = status.kind === "empty" ? null : status.environmentLabel;
  switch (status.kind) {
    case "empty":
      return { title: "Add a project to see its pull requests", detail: null, offerPicker: false };
    case "waiting":
      return status.stalled
        ? {
            title: where ? `Still waiting for ${where}` : "Still waiting for its environment",
            detail: "The link opens here once its repository syncs.",
            offerPicker: true,
          }
        : {
            title: where ? `Connecting to ${where}…` : "Waiting for the repository to sync…",
            detail: null,
            offerPicker: false,
          };
    case "unavailable":
      return status.reason === "offline"
        ? {
            title: where ? `${where} is offline` : "Its environment is offline",
            detail: "The link opens here when it reconnects.",
            offerPicker: true,
          }
        : {
            title: "This repository isn’t available here",
            detail: "It may have been removed from Ryco, or the link is from another device.",
            offerPicker: true,
          };
  }
}

/**
 * Why there is no repository to read, with a picker for the ones that are
 * there. Never substitutes one silently: a link names exactly one checkout,
 * and `#N` in another repository is a different pull request.
 */
export function RepositoryStatusMessage(props: {
  readonly status: Exclude<PullRequestsRepositoryStatus, { readonly kind: "ready" }>;
}) {
  const { repositories, nav } = usePullRequestsPage();
  const pickerLabelId = useId();
  const message = describeRepositoryStatus(props.status);
  const options = message.offerPicker ? repositories : [];
  return (
    <div
      data-repository-status={props.status.kind}
      className="flex flex-col items-center gap-1.5 px-6 pt-12 text-center"
    >
      <div role="status" className="flex flex-col items-center gap-1.5">
        <p className="text-[13px] text-muted-foreground">{message.title}</p>
        {message.detail ? (
          <p className="max-w-64 text-xs text-muted-foreground/70">{message.detail}</p>
        ) : null}
      </div>
      {options.length > 0 ? (
        <nav
          aria-labelledby={pickerLabelId}
          className="mt-4 flex w-full max-w-72 flex-col border-t border-border/60 pt-2 text-left"
        >
          <p id={pickerLabelId} className="px-2 pb-1 text-[11px] text-muted-foreground">
            Open another repository
          </p>
          <ul className="max-h-64 overflow-y-auto">
            {options.map((option) => {
              const environment = pullRequestRepositoryQualifier(option, repositories);
              return (
                <li key={option.key}>
                  <button
                    type="button"
                    className="flex w-full min-w-0 flex-col rounded-md px-2 py-1.5 text-left outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent/55 focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => nav.selectRepository(option)}
                  >
                    <span className="truncate text-[13px] text-foreground/90">
                      {option.name}
                      {environment ? (
                        <span className="text-muted-foreground"> · {environment}</span>
                      ) : null}
                    </span>
                    <span className="truncate font-mono text-[11px] text-muted-foreground">
                      {option.cwd}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}
    </div>
  );
}
