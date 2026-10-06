import { useNavigate } from "@tanstack/react-router";
import {
  ChartNoAxesColumnIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  GitPullRequestIcon,
  Trash2Icon,
} from "lucide-react";
import { useMemo } from "react";

import { PAGE_BAR_CLASS, PAGE_BAR_TRAILING_WCO_INSET_CLASS } from "../../../appChrome";
import { usePageLeadingInsetClass } from "../../../hooks/usePageLeadingInsetClass";
import { openExternalLink } from "../../../lib/openExternalLink";
import { cn } from "../../../lib/utils";
import { buildPullRequestsPageLocation } from "../../../pullRequestsRoute";
import type { SidebarProjectGroupMember } from "../../../sidebarProjectGrouping";
import { RollingText, useTravelDirection } from "../../chat/RollingText";
import { DeviceIcon } from "../../DeviceIcon";
import { ProjectFavicon } from "../../ProjectFavicon";
import { resolveProjectRemoteLink } from "../../sidebar/sidebarProjectRemoteLink";
import { parseStatisticsSearch } from "../../statistics/statisticsSearch";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../ui/menu";
import { toastManager } from "../../ui/toast";
import { formatProjectPath } from "../projectsModel.logic";
import { useProjectsPage, useProjectsSelection } from "../ProjectsPageContext";
import { resolveProjectsView, type ProjectsView } from "../projectsSearch";
import { useEnvironmentPresence } from "../useEnvironmentPresence";
import { useProjectDetail } from "./ProjectDetailContext";
import { ProjectListDrawerButton } from "./ProjectDetailStatus";

const ICON_BUTTON_CLASS =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground [-webkit-app-region:no-drag]";

/** One checkout in the scope menu: its device, path, and reachability. */
function ScopeMenuItem(props: {
  readonly member: SidebarProjectGroupMember;
  readonly current: boolean;
  readonly onSelect: () => void;
}) {
  const presence = useEnvironmentPresence(props.member.environmentId);
  return (
    <MenuItem onClick={props.onSelect} className="items-start gap-2.5 py-1.5">
      <DeviceIcon
        environmentId={props.member.environmentId}
        label={presence.label}
        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px]">
          {presence.label}
          {presence.status !== "online" ? (
            <span className="text-muted-foreground"> · {presence.status}</span>
          ) : null}
        </span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {props.member.cwd}
        </span>
      </span>
      {props.current ? <CheckIcon className="mt-0.5 size-3.5 shrink-0" /> : null}
    </MenuItem>
  );
}

/**
 * Which checkout the page edits, shown only when the project lives
 * in more than one place. The device name rolls when the scope changes.
 */
function ProjectScopeSwitcher() {
  const { nav, layout } = useProjectsPage();
  const { snapshot, member } = useProjectsSelection();
  const presence = useEnvironmentPresence(member.environmentId);
  const index = snapshot.memberProjects.findIndex(
    (candidate) => candidate.environmentId === member.environmentId && candidate.id === member.id,
  );
  // The device name rolls the way the scope moved through the list.
  const direction = useTravelDirection(index);
  if (snapshot.memberProjects.length < 2) return null;
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={`Editing the checkout on ${presence.label}. Change checkout`}
            className={cn(ICON_BUTTON_CLASS, "w-auto gap-1.5 px-2 text-xs")}
          />
        }
      >
        <DeviceIcon
          environmentId={member.environmentId}
          label={presence.label}
          className="size-3.5"
        />
        {layout.barCompact ? null : (
          <RollingText
            text={presence.label}
            direction={direction}
            className="max-w-40 text-foreground/90"
          />
        )}
        <ChevronDownIcon className="size-3 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="end" className="w-80">
        {snapshot.memberProjects.map((candidate) => (
          <ScopeMenuItem
            key={`${candidate.environmentId}:${candidate.id}`}
            member={candidate}
            current={candidate.environmentId === member.environmentId && candidate.id === member.id}
            onSelect={() =>
              nav.selectCheckout({
                environmentId: candidate.environmentId,
                projectId: candidate.id,
              })
            }
          />
        ))}
      </MenuPopup>
    </Menu>
  );
}

/** Secondary project actions. Destructive work routes to the danger zone, its one home. */
function ProjectOverflowMenu() {
  const navigate = useNavigate();
  const { revealSection } = useProjectDetail();
  const { member } = useProjectsSelection();
  const presence = useEnvironmentPresence(member.environmentId);
  const remoteLink = resolveProjectRemoteLink(
    member.repositoryIdentity,
    member.preferredRemoteName,
  );
  const statisticsSearch = useMemo(
    () => parseStatisticsSearch({ environmentIds: [member.environmentId], projectId: member.id }),
    [member.environmentId, member.id],
  );
  return (
    <Menu>
      <MenuTrigger
        render={<button type="button" aria-label="Project actions" className={ICON_BUTTON_CLASS} />}
      >
        <EllipsisIcon className="size-4" />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-56">
        {remoteLink ? (
          <MenuItem
            onClick={() => openExternalLink(remoteLink.url, "Unable to open remote repository")}
          >
            <ExternalLinkIcon className="size-4" />
            Open on {remoteLink.providerLabel}
          </MenuItem>
        ) : null}
        <MenuItem
          onClick={() => {
            void navigator.clipboard?.writeText(member.cwd).then(
              () =>
                toastManager.add({
                  type: "success",
                  title: "Path copied",
                  description: member.cwd,
                }),
              () => toastManager.add({ type: "error", title: "Could not copy the path" }),
            );
          }}
        >
          <CopyIcon className="size-4" />
          Copy path
        </MenuItem>
        {member.repositoryIdentity ? (
          <MenuItem
            onClick={() =>
              void navigate(
                buildPullRequestsPageLocation({
                  environmentId: member.environmentId,
                  projectId: member.id,
                }),
              )
            }
          >
            <GitPullRequestIcon className="size-4" />
            Pull requests
          </MenuItem>
        ) : null}
        <MenuItem onClick={() => void navigate({ to: "/statistics", search: statisticsSearch })}>
          <ChartNoAxesColumnIcon className="size-4" />
          Usage statistics
        </MenuItem>
        <MenuSeparator />
        <MenuItem variant="destructive" onClick={() => revealSection("danger")}>
          <Trash2Icon className="size-4" />
          Remove from {presence.isPrimary ? "this device" : presence.label}…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

const VIEWS: ReadonlyArray<{ readonly view: ProjectsView; readonly label: string }> = [
  { view: "map", label: "Map" },
  { view: "settings", label: "Settings" },
];

/**
 * Map or Settings: one quiet switch whose plate travels between the two.
 * The map shows the project across its devices; settings edit one checkout.
 */
function ProjectViewSwitch() {
  const { nav } = useProjectsPage();
  const current = resolveProjectsView(nav.search);
  const index = VIEWS.findIndex((entry) => entry.view === current);
  return (
    <div
      role="radiogroup"
      aria-label="Project view"
      className="relative mr-1 grid shrink-0 grid-cols-2 rounded-lg bg-accent/60 p-0.5 [-webkit-app-region:no-drag]"
    >
      <span
        aria-hidden
        className="projects-view-plate absolute top-0.5 bottom-0.5 left-0.5 rounded-md bg-background shadow-xs"
        style={{ width: "calc(50% - 2px)", translate: `${index * 100}% 0` }}
      />
      {VIEWS.map((entry) => (
        <button
          key={entry.view}
          type="button"
          role="radio"
          aria-checked={entry.view === current}
          onClick={() => nav.setView(entry.view)}
          className={cn(
            "relative z-10 h-6 min-w-[4.5rem] rounded-md px-2.5 text-xs font-medium outline-hidden transition-colors duration-(--app-motion-duration-chip) focus-visible:ring-2 focus-visible:ring-ring",
            entry.view === current
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The detail's one 52px bar: the list toggle on a narrow page, the project
 * name (always on the map; once the hero scrolls away in settings), the
 * Map/Settings switch, the checkout scope and secondary actions.
 */
export function ProjectBar(props: { readonly heroInView: boolean }) {
  const { layout, nav } = useProjectsPage();
  const { snapshot, member } = useProjectsSelection();
  const insetClass = usePageLeadingInsetClass(layout.leadingRegion === "detail", "pl-2");
  const onMap = resolveProjectsView(nav.search) === "map";
  const titleVisible = onMap || !props.heroInView;
  return (
    <header
      className={cn(PAGE_BAR_CLASS, insetClass, "gap-1 pr-2", PAGE_BAR_TRAILING_WCO_INSET_CLASS)}
    >
      <ProjectListDrawerButton />
      <div
        className="projects-bar-title flex min-w-0 flex-1 items-center gap-2 px-1.5"
        data-visible={titleVisible ? "true" : "false"}
        aria-hidden={titleVisible ? undefined : true}
      >
        <span className="grid size-4 shrink-0 place-items-center overflow-hidden rounded-[min(var(--radius-sm),0.25rem)] text-muted-foreground">
          <ProjectFavicon
            environmentId={member.environmentId}
            cwd={member.cwd}
            projectId={member.id}
            customAvatarContentHash={member.customAvatarContentHash ?? null}
            className="size-4"
          />
        </span>
        <span
          className="min-w-0 truncate text-sm font-semibold tracking-tight"
          title={formatProjectPath(member.cwd, null)}
        >
          {snapshot.displayName}
        </span>
      </div>
      <ProjectViewSwitch />
      {onMap ? null : <ProjectScopeSwitcher />}
      <ProjectOverflowMenu />
    </header>
  );
}
