/**
 * The dialog's one header bar: Automations / [project switcher] [the limit,
 * said once] … [what waits] [time zone] [New schedule] [×].
 */
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { formatTime, localTimeZone } from "@ryco/shared/automationSchedule";
import { CheckIcon, ChevronsUpDownIcon, ClockIcon, PlusIcon, XIcon } from "lucide-react";
import type { Ref } from "react";

import { ProjectFavicon } from "../../ProjectFavicon";
import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";
import { DialogTitle } from "../../ui/dialog";
import { Menu, MenuPopup, MenuTrigger } from "../../ui/menu";
import { useAutomationProjectCounts } from "../data/useAutomationProjectCounts";
import { Countdown } from "./Ticking";
import { DialogButton, Tip } from "./dialogControls";
import { focusCheckedItemOnEntry } from "./menuFocus";
import type { DialogLimit, DialogQueueLine } from "./dialogModel.logic";
import { plural, queueChangesLabel, queueRunsLabel } from "./dialogWords";

export interface AutomationsDialogHeaderProps {
  readonly project: SidebarProjectSnapshot;
  readonly projects: readonly SidebarProjectSnapshot[];
  /** The shown project's counts, live. */
  readonly currentCounts: { readonly schedules: number; readonly waiting: number };
  readonly editing: boolean;
  readonly limit: DialogLimit;
  /**
   * Why "New schedule" is off besides the limit — a hosted reader's role, or
   * no device of the project could be read — or null.
   */
  readonly lockedReason: string | null;
  /** The project lives on more than one device (the cap names the device). */
  readonly multiDevice: boolean;
  readonly queue: DialogQueueLine;
  readonly newButtonRef: Ref<HTMLButtonElement>;
  readonly onSwitchProject: (projectKey: string) => void;
  readonly onNew: (origin: HTMLElement) => void;
  readonly onClose: () => void;
  /** A queue part was chosen: select that row. */
  readonly onShowRow: (rowKey: string) => void;
}

export function AutomationsDialogHeader({ newButtonRef, ...props }: AutomationsDialogHeaderProps) {
  const { project, limit, editing } = props;
  const name = project.displayName;
  const fullWhy = limit.allFull
    ? `${name} has ${limit.perProject} active schedules, the most a project can have. Pause or cancel one to add another.`
    : undefined;
  return (
    <header className="ad-head">
      <DialogTitle className="ad-title">Automations</DialogTitle>
      <span className="ad-slash" aria-hidden="true">
        /
      </span>
      <ProjectSwitcher
        project={project}
        projects={props.projects}
        currentCounts={props.currentCounts}
        editing={editing}
        onSwitchProject={props.onSwitchProject}
      />
      {limit.show ? (
        <span className="ad-cap tnum" data-full={limit.full ? "" : undefined}>
          {limit.active} of {limit.perProject} active
          {props.multiDevice && limit.deviceLabel ? ` on ${limit.deviceLabel}` : ""}
        </span>
      ) : null}
      <span className="ad-sp" />
      <QueueLine queue={props.queue} editing={editing} onShowRow={props.onShowRow} />
      <Tip label="Times are local">
        <span className="ad-tz">
          <ClockIcon aria-hidden="true" />
          {localTimeZone()}
        </span>
      </Tip>
      <DialogButton
        className="ad-new"
        ref={newButtonRef}
        disabled={editing}
        off={limit.allFull}
        offReason={props.lockedReason}
        ariaDescription={fullWhy}
        tip={limit.allFull ? "Pause or cancel one to add another" : "New schedule · N"}
        ariaKeyShortcuts="N"
        dataAct="new"
        onAction={(event) => props.onNew(event.currentTarget)}
      >
        <PlusIcon />
        New schedule
      </DialogButton>
      <DialogButton
        tone="quiet"
        icon
        ariaLabel="Close"
        tip="Close · Esc"
        ariaKeyShortcuts="Escape"
        dataAct="close"
        onAction={props.onClose}
      >
        <XIcon />
      </DialogButton>
    </header>
  );
}

function ProjectSwitcher(props: {
  readonly project: SidebarProjectSnapshot;
  readonly projects: readonly SidebarProjectSnapshot[];
  readonly currentCounts: { readonly schedules: number; readonly waiting: number };
  readonly editing: boolean;
  readonly onSwitchProject: (projectKey: string) => void;
}) {
  const { project } = props;
  const counts = useAutomationProjectCounts(props.projects);
  const face = (
    <>
      <ProjectFavicon
        environmentId={project.environmentId}
        cwd={project.cwd}
        projectId={project.id}
        customAvatarContentHash={project.customAvatarContentHash ?? null}
        fallbackName={project.displayName}
        className="ad-fav"
      />
      <span className="ad-trunc">{project.displayName}</span>
      <ChevronsUpDownIcon className="ad-switch-ic" aria-hidden="true" />
    </>
  );
  const label = `Project: ${project.displayName}. Switch project`;
  // One draft at a time: the project can't change under an open editor.
  if (props.editing)
    return (
      <Tip label="Save or discard the edit first">
        <button type="button" className="ad-switch" aria-label={label} aria-disabled="true">
          {face}
        </button>
      </Tip>
    );
  return (
    <Menu onOpenChange={(open) => (open ? counts.request() : counts.cancel())}>
      <MenuTrigger
        render={<button type="button" className="ad-switch" aria-label={label} data-act="switch" />}
      >
        {face}
      </MenuTrigger>
      <MenuPopup
        align="start"
        className="ad-menu ad-switch-menu"
        aria-label="Project"
        onFocus={focusCheckedItemOnEntry}
      >
        <MenuPrimitive.RadioGroup
          value={project.projectKey}
          onValueChange={(value) => {
            if (typeof value === "string" && value !== project.projectKey)
              props.onSwitchProject(value);
          }}
        >
          {props.projects.map((candidate) => {
            const known =
              candidate.projectKey === project.projectKey
                ? props.currentCounts
                : (counts.counts.get(candidate.projectKey) ?? null);
            const n = known?.schedules ?? 0;
            const w = known?.waiting ?? 0;
            return (
              <MenuPrimitive.RadioItem
                key={candidate.projectKey}
                value={candidate.projectKey}
                closeOnClick
                className="ad-mi"
                // Typeahead matches the name, not the favicon's initials or the count.
                label={candidate.displayName}
                aria-label={
                  known
                    ? `${candidate.displayName}, ${n ? plural(n, "schedule") : "no schedules"}${w ? `, ${plural(w, "run")} waiting` : ""}`
                    : candidate.displayName
                }
              >
                <ProjectFavicon
                  environmentId={candidate.environmentId}
                  cwd={candidate.cwd}
                  projectId={candidate.id}
                  customAvatarContentHash={candidate.customAvatarContentHash ?? null}
                  fallbackName={candidate.displayName}
                  className="ad-fav"
                />
                <span className="ad-mi-t">
                  <span className="ad-mi-l ad-trunc">{candidate.displayName}</span>
                </span>
                <span className="ad-mi-a" aria-hidden="true">
                  {w ? <span className="ad-glyph" data-g="awaiting-approval" /> : null}
                  {known ? <span className="tnum">{n || "—"}</span> : null}
                </span>
                <span className="ad-mi-ck-slot">
                  <MenuPrimitive.RadioItemIndicator className="ad-mi-ck">
                    <CheckIcon aria-hidden="true" />
                  </MenuPrimitive.RadioItemIndicator>
                </span>
              </MenuPrimitive.RadioItem>
            );
          })}
        </MenuPrimitive.RadioGroup>
      </MenuPopup>
    </Menu>
  );
}

/**
 * Runs waiting (time-boxed) · changes waiting (no deadline). Each part
 * selects that schedule; the selected one is left out of it.
 */
function QueueLine(props: {
  readonly queue: DialogQueueLine;
  readonly editing: boolean;
  readonly onShowRow: (rowKey: string) => void;
}) {
  const { runs, changes } = props.queue;
  if (!runs && !changes) return null;
  const off = props.editing || undefined;
  return (
    <div className="ad-queue" role="group" aria-label="Waiting for you">
      {runs ? (
        <button
          type="button"
          className="ad-q"
          data-act="q-run"
          aria-disabled={off}
          aria-label={queueRunsLabel(runs.count, runs.title, formatTime(runs.expiresAtMs))}
          onClick={() => {
            if (!props.editing) props.onShowRow(runs.first.key);
          }}
        >
          <span className="ad-glyph" data-g="awaiting-approval" aria-hidden="true" />
          <span>{plural(runs.count, "run")} waiting</span>
          <span className="ad-q-sep" aria-hidden="true">
            ·
          </span>
          <Countdown className="ad-q-left tnum" expiresAtMs={runs.expiresAtMs} />
        </button>
      ) : null}
      {runs && changes ? <span className="ad-q-div" aria-hidden="true" /> : null}
      {changes ? (
        <button
          type="button"
          className="ad-q"
          data-act="q-prop"
          aria-disabled={off}
          aria-label={queueChangesLabel(changes.count)}
          onClick={() => {
            if (!props.editing) props.onShowRow(changes.first.key);
          }}
        >
          <span className="ad-glyph" data-g="pending-create" aria-hidden="true" />
          <span>{plural(changes.count, "change")} waiting</span>
        </button>
      ) : null}
    </div>
  );
}
