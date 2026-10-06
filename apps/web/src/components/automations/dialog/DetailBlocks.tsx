/**
 * The detail's blocks — things waiting on the user, one hairline box each,
 * never nested: a proposed schedule change (dashed), a proposal that expired
 * undecided, the run waiting for approval (its one countdown, its one
 * Approve, a draining line), and a run being started.
 */
import { diffScheduleDefinitions, type ScheduleRow } from "@ryco/client-runtime/state/agentControl";
import type { ServerProvider } from "@ryco/contracts";
import { formatTime, when } from "@ryco/shared/automationSchedule";
import { ChevronRightIcon } from "lucide-react";

import { runtimeModeConfig } from "../../chat/sessionPolicyPresentation";
import { Countdown, DrainLine } from "./Ticking";
import { DialogButton, type ScheduleDialogActions } from "./dialogControls";
import type { DialogRow } from "./dialogModel.logic";
import {
  PROPOSAL_HEAD,
  approveProposalLabel,
  lapsedWords,
  plural,
  proposalNote,
  rejectProposalLabel,
  runStatusLabel,
} from "./dialogWords";

interface BlockProps {
  readonly item: DialogRow;
  readonly nowMs: number;
  readonly actions: ScheduleDialogActions;
  /** Why changes are off on this device (a hosted reader's role), or null. */
  readonly lockedReason: string | null;
}

const runtimeModeLabel = (mode: keyof typeof runtimeModeConfig) => runtimeModeConfig[mode].label;

/** A schedule change waiting for the user. Neutral: one dashed hairline, no fill. */
export function ProposalBlock(
  props: BlockProps & { readonly providers: readonly ServerProvider[] },
) {
  const { item, nowMs, actions } = props;
  const proposal = item.row.proposal;
  if (!proposal) return null;
  const head = PROPOSAL_HEAD[proposal.kind];
  const diff =
    proposal.kind === "edit" && proposal.before && proposal.after
      ? diffScheduleDefinitions(proposal.before, proposal.after, {
          nowMs,
          runtimeModeLabel,
          providers: props.providers,
        })
      : [];
  const note = proposalNote(proposal, item.row.automation, nowMs);
  const aside =
    Number.isFinite(proposal.expiresAtMs) && proposal.expiresAtMs > nowMs
      ? `Expires ${formatTime(proposal.expiresAtMs)}`
      : "";
  return (
    <section className="ad-blk ad-blk-prop" aria-label={head}>
      <div className="ad-blk-h">
        <span className="ad-glyph" data-g="pending-create" aria-hidden="true" />
        <b>{head}</b>
        {aside ? <span className="ad-blk-aside tnum">{aside}</span> : null}
      </div>
      {diff.length ? (
        <dl className="ad-diff">
          {diff.map((change) => (
            <div key={change.key} className="ad-diff-row">
              <dt>{change.label}</dt>
              <dd>
                {change.before !== null ? (
                  <>
                    <s>{change.before}</s>
                    <ChevronRightIcon className="ad-diff-arrow" aria-hidden="true" />
                    <span className="sr-only">changes to</span>
                  </>
                ) : null}
                <span>{change.after}</span>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {note ? <p className="ad-blk-p">{note}</p> : null}
      <div className="ad-blk-x">
        <DialogButton
          tone="primary"
          offReason={props.lockedReason}
          dataAct="approve-prop"
          onAction={() => actions.approveProposal(item)}
        >
          {approveProposalLabel(proposal.kind)}
        </DialogButton>
        <DialogButton
          tone="quiet"
          offReason={props.lockedReason}
          dataAct="reject-prop"
          onAction={() => actions.rejectProposal(item)}
        >
          {rejectProposalLabel(proposal.kind)}
        </DialogButton>
      </div>
    </section>
  );
}

/** A proposal that expired undecided: say so, offer to propose it again. */
export function LapsedBlock(props: BlockProps) {
  const { item, actions } = props;
  const lapsed = item.row.lapsed;
  if (!lapsed) return null;
  const words = lapsedWords(lapsed.kind);
  return (
    <section className="ad-blk ad-blk-lapsed" aria-label="Proposal expired">
      <div className="ad-blk-h">
        <span className="ad-glyph" data-g="lapsed" aria-hidden="true" />
        <b>{words.title}</b>
        <span className="ad-blk-aside tnum">{formatTime(lapsed.expiresAtMs)}</span>
      </div>
      <p className="ad-blk-p">{words.body}</p>
      <div className="ad-blk-x">
        <DialogButton
          offReason={props.lockedReason}
          dataAct="repropose"
          onAction={(event) => actions.repropose(item, event.currentTarget)}
        >
          Propose again
        </DialogButton>
        <DialogButton
          tone="quiet"
          dataAct="dismiss-lapsed"
          onAction={() => actions.dismissLapsed(item)}
        >
          {words.dismiss}
        </DialogButton>
      </div>
    </section>
  );
}

/**
 * The due run. The sentence above already says where it runs; this block
 * owns the one countdown and the one Approve. Neutral until the last 2 min.
 */
export function DueRunBlock(props: BlockProps) {
  const { item, nowMs, actions } = props;
  const due = item.row.dueRun;
  if (!due) return null;
  const expires = formatTime(due.expiresAtMs);
  return (
    <section className="ad-blk ad-blk-due" aria-label="Run waiting for approval">
      <div className="ad-blk-h">
        <span className="ad-glyph" data-g="awaiting-approval" aria-hidden="true" />
        <b>Run for {when(due.scheduledForMs, nowMs)}</b>
        <span className="ad-blk-aside tnum" role="timer" aria-label={`Expires ${expires}`}>
          Expires {expires} · <Countdown className="ad-blk-cd" expiresAtMs={due.expiresAtMs} />
        </span>
      </div>
      <p className="ad-blk-p">
        {due.coalescedOccurrences ? (
          <>
            <b>{plural(due.coalescedOccurrences, "missed run")}</b> → approving starts one run now.
          </>
        ) : (
          "Approving starts one thread now."
        )}
      </p>
      <div className="ad-blk-x">
        <DialogButton
          tone="primary"
          offReason={props.lockedReason}
          dataAct="approve-run"
          onAction={() => actions.approveRun(item)}
        >
          Approve run
        </DialogButton>
        <DialogButton
          tone="quiet"
          offReason={props.lockedReason}
          dataAct="reject-run"
          onAction={() => actions.rejectRun(item)}
        >
          Reject
        </DialogButton>
      </div>
      <DrainLine expiresAtMs={due.expiresAtMs} />
    </section>
  );
}

/** A run past approval whose thread is being started. */
export function ActiveRunBlock(props: { readonly row: ScheduleRow; readonly deviceLabel: string }) {
  const active = props.row.activeRun;
  if (!active) return null;
  const status = active.run.status;
  return (
    <section className="ad-blk ad-blk-run">
      <span className="ad-glyph" data-g="running" aria-hidden="true" />
      <b>{runStatusLabel(status)}</b>
      <span className="ad-muted">
        {status === "approved" ? "Handing the run to" : "Creating the thread on"}{" "}
        {props.deviceLabel}.
      </span>
    </section>
  );
}

/** Whether a row has any block to show. */
export function hasBlocks(row: ScheduleRow): boolean {
  return !!(row.proposal || row.lapsed || row.dueRun || row.activeRun);
}
