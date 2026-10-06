/**
 * The selected schedule: its heading and actions, the read-only sentence
 * (when + where), the model line, warnings, the blocks waiting on the user,
 * When, Prompt and the run history. Every fact once.
 */
import {
  activeScheduleCount,
  envWords,
  isSchedulePaused,
  scheduleModelLabel,
  type ScheduleRow,
} from "@ryco/client-runtime/state/agentControl";
import type { AgentControlAutomationDefinition, ServerProvider } from "@ryco/contracts";
import { clockChange, phrase, validateScheduleDefinition } from "@ryco/shared/automationSchedule";
import {
  BanIcon,
  CircleAlertIcon,
  ClockIcon,
  EllipsisVerticalIcon,
  FilePenIcon,
  PauseIcon,
  PlayIcon,
} from "lucide-react";
import { useId } from "react";

import { ProviderInstanceIcon } from "../../chat/ProviderInstanceIcon";
import { runtimeModeConfig } from "../../chat/sessionPolicyPresentation";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import type { ProjectAutomationsCheckout } from "../data/useProjectAutomations";
import { ActiveRunBlock, DueRunBlock, LapsedBlock, ProposalBlock, hasBlocks } from "./DetailBlocks";
import { RunHistory } from "./RunHistory";
import { RelativeTime } from "./Ticking";
import { DialogButton, Tip, type ScheduleDialogActions } from "./dialogControls";
import type { DialogRow } from "./dialogModel.logic";
import { detailVerb, scheduleWhenLine } from "./dialogWords";

/** The prompt clamps to three lines past this many characters. */
const PROMPT_CLAMP_CHARS = 220;

/**
 * "Runs **every 2 hours until Oct 20** in **the main checkout** on **This
 * device**." — the read-only sentence the editor turns into tokens.
 */
export function ScheduleSentence(props: {
  readonly verb: string;
  readonly definition: AgentControlAutomationDefinition;
  readonly deviceLabel: string;
  readonly nowMs: number;
}) {
  const ex = props.definition.execution;
  return (
    <p className="ad-sentence-ro">
      {props.verb} <b>{phrase(props.definition.schedule, props.nowMs)}</b> in{" "}
      <b>{envWords(ex.envMode)}</b>
      {ex.envMode === "worktree" && ex.baseRef ? (
        <>
          {" "}
          off <b className="ad-ref">{ex.baseRef}</b>
        </>
      ) : null}{" "}
      on <b>{props.deviceLabel}</b>.
    </p>
  );
}

/** Provider mark, model (with effort) · permissions. */
export function ScheduleModelLine(props: {
  readonly definition: AgentControlAutomationDefinition;
  readonly providers: readonly ServerProvider[];
}) {
  const ex = props.definition.execution;
  const provider = props.providers.find(
    (candidate) => candidate.instanceId === ex.modelSelection.instanceId,
  );
  return (
    <p className="ad-meta">
      {provider ? (
        <ProviderInstanceIcon
          driverKind={provider.driver}
          displayName={provider.displayName ?? provider.instanceId}
          className="ad-prov"
          iconClassName="size-3.5"
        />
      ) : null}
      <span>{scheduleModelLabel(ex.modelSelection, props.providers, { effort: true })}</span>
      <span className="ad-sep" aria-hidden="true">
        ·
      </span>
      <span>{runtimeModeConfig[ex.runtimeMode].label}</span>
    </p>
  );
}

export interface ScheduleDetailProps {
  readonly item: DialogRow;
  readonly checkout: ProjectAutomationsCheckout;
  /** The checkout's rows (retry rules). */
  readonly scheduleRows: readonly ScheduleRow[];
  readonly projectName: string;
  readonly nowMs: number;
  readonly historyOpen: boolean;
  readonly promptOpen: boolean;
  readonly focusRunId: string | null;
  readonly actions: ScheduleDialogActions;
}

export function ScheduleDetail(props: ScheduleDetailProps) {
  const { item, checkout, nowMs, actions } = props;
  const row = item.row;
  const automation = row.automation;
  const def = row.def;
  const ex = def.execution;
  const resumeWhyId = useId();
  const providers = checkout.providers.length ? checkout.providers : undefined;
  const lockedReason = checkout.disabledReason;
  const validation = validateScheduleDefinition(def, nowMs, providers ? { providers } : {});
  const paused = isSchedulePaused(automation);
  // Resuming is a save with `enabled` flipped, so the save rules apply.
  const resume = paused
    ? validateScheduleDefinition({ ...def, enabled: true }, nowMs, {
        activeCount: activeScheduleCount(checkout.snapshot),
        editingActive: false,
        projectName: props.projectName,
        ...(providers ? { providers } : {}),
      })
    : null;
  const modelGone = !!resume?.errors.model;
  const whenLine = scheduleWhenLine(row, nowMs);
  const dst = automation?.enabled && automation.nextRunAt ? clockChange(def.schedule, nowMs) : null;
  const longPrompt = ex.prompt.length > PROMPT_CLAMP_CHARS;

  return (
    <>
      <header className="ad-dh">
        <div className="ad-dh-t">
          <h3 className="ad-dtitle">{row.title || "Untitled schedule"}</h3>
          {row.state === "paused" ? (
            <span className="ad-chip">
              <PauseIcon aria-hidden="true" />
              Paused
            </span>
          ) : row.state === "finished" ? (
            <span className="ad-chip">Finished</span>
          ) : null}
        </div>
        <div className="ad-dh-x">
          {/* A paused schedule whose model is gone gets one edit action, not two. */}
          {row.state !== "lapsed" && !modelGone ? (
            <DialogButton
              tip="Edit · E"
              offReason={lockedReason}
              ariaKeyShortcuts="E"
              dataAct="edit"
              onAction={() => actions.edit(item, "title")}
            >
              <FilePenIcon />
              Edit
            </DialogButton>
          ) : null}
          {automation && !automation.cancelled ? (
            <>
              {automation.enabled && automation.nextRunAt !== null ? (
                <DialogButton
                  offReason={lockedReason}
                  dataAct="pause"
                  onAction={() => actions.pause(item)}
                >
                  <PauseIcon />
                  Pause
                </DialogButton>
              ) : paused && modelGone ? (
                <DialogButton
                  offReason={lockedReason}
                  dataAct="resume-model"
                  onAction={() => actions.edit(item, "model")}
                >
                  <FilePenIcon />
                  Edit model to resume
                </DialogButton>
              ) : paused && resume?.errors.limit ? (
                <DialogButton
                  off
                  ariaDescribedBy={resumeWhyId}
                  dataAct="resume"
                  onAction={() => undefined}
                >
                  <PlayIcon />
                  Resume
                </DialogButton>
              ) : paused ? (
                <DialogButton
                  offReason={lockedReason}
                  dataAct="resume"
                  onAction={() => actions.resume(item)}
                >
                  <PlayIcon />
                  Resume
                </DialogButton>
              ) : null}
              <MoreActions item={item} lockedReason={lockedReason} actions={actions} />
            </>
          ) : null}
        </div>
      </header>
      <ScheduleSentence
        verb={detailVerb(row.state)}
        definition={def}
        deviceLabel={checkout.deviceLabel}
        nowMs={nowMs}
      />
      <ScheduleModelLine definition={def} providers={checkout.providers} />
      {validation.errors.model ? (
        <p className="ad-warnline">
          <CircleAlertIcon aria-hidden="true" />
          <span>{validation.errors.model}</span>
          {paused ? null : (
            <button
              type="button"
              className="ad-link"
              data-act="warn-edit"
              onClick={() => actions.edit(item, "model")}
            >
              Edit model
            </button>
          )}
        </p>
      ) : resume?.errors.limit ? (
        <p className="ad-warnline" id={resumeWhyId}>
          <CircleAlertIcon aria-hidden="true" />
          <span>{resume.errors.limit}</span>
        </p>
      ) : null}
      {checkout.error && checkout.snapshot ? (
        <p className="ad-warnline" role="status">
          <CircleAlertIcon aria-hidden="true" />
          <span>{checkout.error}</span>
        </p>
      ) : null}
      {hasBlocks(row) ? (
        <div className="ad-blks">
          <ProposalBlock
            item={item}
            nowMs={nowMs}
            actions={actions}
            lockedReason={lockedReason}
            providers={checkout.providers}
          />
          <LapsedBlock item={item} nowMs={nowMs} actions={actions} lockedReason={lockedReason} />
          <DueRunBlock item={item} nowMs={nowMs} actions={actions} lockedReason={lockedReason} />
          <ActiveRunBlock row={row} deviceLabel={checkout.deviceLabel} />
        </div>
      ) : null}
      <section className="ad-sec ad-when">
        <h4 className="ad-sec-h">When</h4>
        <p className="ad-when-p">
          {whenLine.kind === "quiet" ? (
            <span className="ad-muted">{whenLine.text}</span>
          ) : whenLine.kind === "first" ? (
            <>
              First run <b>{whenLine.at}</b>
              {whenLine.tail ? <span className="ad-muted"> · {whenLine.tail}</span> : null}
            </>
          ) : (
            <>
              Next run <b>{whenLine.at}</b>{" "}
              <span className="ad-muted tnum">
                · <RelativeTime atMs={whenLine.nextRunAt} />
              </span>
              {whenLine.tail ? <span className="ad-muted"> · {whenLine.tail}</span> : null}
            </>
          )}
        </p>
        {dst ? (
          <p className="ad-note">
            <ClockIcon aria-hidden="true" />
            <span>{dst.text}</span>
          </p>
        ) : null}
      </section>
      <section className="ad-sec">
        <h4 className="ad-sec-h">Prompt</h4>
        <p className="ad-prompt" data-clamped={longPrompt && !props.promptOpen ? "" : undefined}>
          {ex.prompt}
        </p>
        {longPrompt ? (
          <button
            type="button"
            className="ad-link"
            data-act="toggle-prompt"
            onClick={() => actions.togglePrompt(item.key)}
          >
            {props.promptOpen ? "Show less" : "Show all"}
          </button>
        ) : null}
      </section>
      {automation ? (
        <RunHistory
          item={item}
          scheduleRows={props.scheduleRows}
          nowMs={nowMs}
          showAll={props.historyOpen}
          focusRunId={props.focusRunId}
          lockedReason={lockedReason}
          actions={actions}
        />
      ) : null}
    </>
  );
}

/** ⋮ — one destructive action, proposed like everything else. */
function MoreActions(props: {
  readonly item: DialogRow;
  readonly lockedReason: string | null;
  readonly actions: ScheduleDialogActions;
}) {
  const hintId = useId();
  return (
    <Menu>
      <Tip label={props.lockedReason}>
        <MenuTrigger
          disabled={!!props.lockedReason}
          render={
            <button
              type="button"
              className="ad-icon-btn"
              aria-label="More actions"
              data-act="more"
            />
          }
        >
          <EllipsisVerticalIcon aria-hidden="true" />
        </MenuTrigger>
      </Tip>
      <MenuPopup align="end" className="ad-menu">
        <MenuItem
          variant="destructive"
          className="ad-mi2"
          aria-label="Cancel schedule"
          aria-describedby={hintId}
          onClick={() => props.actions.cancel(props.item)}
        >
          <BanIcon aria-hidden="true" />
          <span className="ad-mi-t">
            <span className="ad-mi-l">Cancel schedule</span>
            <span className="ad-mi-h" id={hintId}>
              Proposes ending it for good. History stays.
            </span>
          </span>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
