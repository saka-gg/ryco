import { FolderIcon, PanelLeftIcon } from "lucide-react";

import { PAGE_BAR_CLASS, PAGE_BAR_TRAILING_WCO_INSET_CLASS } from "../../../appChrome";
import { usePageLeadingInsetClass } from "../../../hooks/usePageLeadingInsetClass";
import { cn } from "../../../lib/utils";
import { Spinner } from "../../ui/spinner";
import { useProjectsPage, type ProjectsCheckoutStatus } from "../ProjectsPageContext";

/** The sentence for a checkout the URL names but the page cannot show (yet). */
export function describeProjectsCheckoutStatus(
  status: Exclude<ProjectsCheckoutStatus, { readonly kind: "ready" | "empty" }>,
): { readonly title: string; readonly detail: string | null; readonly busy: boolean } {
  switch (status.kind) {
    case "waiting": {
      const where = status.environmentLabel;
      return status.stalled
        ? {
            title: where ? `Still waiting for ${where}` : "Still waiting for its device",
            detail: "The project opens here once its device syncs.",
            busy: true,
          }
        : {
            title: where ? `Connecting to ${where}…` : "Waiting for the project to sync…",
            detail: null,
            busy: false,
          };
    }
    case "unavailable": {
      const where = status.environmentLabel;
      return status.reason === "offline"
        ? {
            title: where ? `${where} is offline` : "Its device is offline",
            detail: "The project opens here when it reconnects.",
            busy: false,
          }
        : {
            title: "This project isn’t available here",
            detail: "It may have been removed, or the link is from another device.",
            busy: false,
          };
    }
  }
}

/** The list toggle shown in the detail bar while the list is a drawer. */
export function ProjectListDrawerButton() {
  const { layout } = useProjectsPage();
  if (layout.listDocked) return null;
  return (
    <button
      type="button"
      aria-label="Show projects"
      onClick={layout.openDrawer}
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <PanelLeftIcon className="size-3.5" />
    </button>
  );
}

/**
 * Detail area without a checkout: why (waiting, unavailable, nothing added),
 * under a quiet bar. Never substitutes another project — the list beside it is
 * the way to pick one.
 */
export function ProjectDetailStatus() {
  const { status, layout } = useProjectsPage();
  const insetClass = usePageLeadingInsetClass(layout.leadingRegion === "detail", "pl-3");
  const bar = (
    <header className={cn(PAGE_BAR_CLASS, insetClass, "pr-3", PAGE_BAR_TRAILING_WCO_INSET_CLASS)}>
      <ProjectListDrawerButton />
    </header>
  );
  // Nothing added yet: the list beside this says so and offers Add project.
  if (status.kind === "empty") return <div className="flex min-h-0 flex-1 flex-col">{bar}</div>;
  const message =
    status.kind === "ready"
      ? { title: "Choose a project.", detail: null, busy: false }
      : describeProjectsCheckoutStatus(status);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {bar}
      <div
        role="status"
        data-projects-status={status.kind}
        className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
      >
        {/* The spinner joins only once the wait has held; quick syncs stay still. */}
        {message.busy ? (
          <Spinner className="size-4 text-muted-foreground/60" />
        ) : (
          <FolderIcon aria-hidden className="size-5 text-muted-foreground/40" />
        )}
        <p className="text-[13px] text-muted-foreground">{message.title}</p>
        {message.detail ? (
          <p className="max-w-72 text-xs text-muted-foreground/70">{message.detail}</p>
        ) : null}
      </div>
    </div>
  );
}
