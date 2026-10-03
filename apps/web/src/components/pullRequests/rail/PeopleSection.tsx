import type { ChangeRequestUpdateAction, SourceControlLabel } from "@ryco/contracts";
import {
  CheckIcon,
  CircleDashedIcon,
  FileDiffIcon,
  MessageSquareIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { cn } from "../../../lib/utils";
import {
  useSourceControlIssueAssignees,
  useSourceControlIssueLabels,
  useUpdateChangeRequestMutation,
} from "../../../rpc/useSourceControl";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { ActorAvatar } from "../primitives";
import { usePullRequestSelection, usePullRequestsPage } from "../PullRequestsPageContext";
import {
  pickerCandidates,
  REVIEWER_STATE_LABEL,
  reviewerRows,
  type ListEdit,
  type ReviewerRow,
} from "./peopleFacts.logic";
import { LabelDot, PickerPopover, type PickerOption } from "./PickerPopover";
import { usePullRequestRailStore, type PeopleField } from "./railStore";

const EMPTY_LOGINS: ReadonlyArray<string> = [];
const EMPTY_LABELS: ReadonlyArray<SourceControlLabel> = [];

const FIELD_NOUN: Record<PeopleField, string> = {
  reviewers: "reviewers",
  assignees: "assignees",
  labels: "labels",
};

/**
 * Reviewers, assignees and labels. Each field's label opens its picker
 * (read-only without `viewer.canUpdate`); closing a picker applies one
 * optimistic edit that rolls back with a toast if the host refuses it.
 */
export function PeopleSection(props: { readonly layout: "rail" | "band" }) {
  const { model } = usePullRequestsPage();
  const selection = usePullRequestSelection();
  const detail = selection.detail.data;
  const viewer = selection.activity.data?.viewer ?? null;
  // Each field edits through its own action kind; the host must apply it.
  const viewerCanUpdate = viewer?.canUpdate === true;
  const lifecycle = model.capabilities.lifecycle;
  const update = useUpdateChangeRequestMutation(selection.mutationTarget);

  const apply = (field: PeopleField, edit: ListEdit) => {
    const action: ChangeRequestUpdateAction = { kind: field, add: edit.add, remove: edit.remove };
    update.mutateAsync(action).catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Couldn’t update ${FIELD_NOUN[field]}`,
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  };

  if (!detail) return null;
  const fields = (
    <>
      <ReviewersField
        layout={props.layout}
        canUpdate={viewerCanUpdate && lifecycle.has("reviewers")}
        onApply={(edit) => apply("reviewers", edit)}
        viewerLogin={viewer?.login ?? null}
      />
      <AssigneesField
        layout={props.layout}
        canUpdate={viewerCanUpdate && lifecycle.has("assignees")}
        viewerLogin={viewer?.login ?? null}
        onApply={(edit) => apply("assignees", edit)}
      />
      <LabelsField
        layout={props.layout}
        canUpdate={viewerCanUpdate && lifecycle.has("labels")}
        onApply={(edit) => apply("labels", edit)}
      />
    </>
  );
  if (props.layout === "band") return fields;
  return (
    <section aria-label="People and labels" className="flex flex-col gap-4">
      {fields}
    </section>
  );
}

// ── Shared field chrome ──────────────────────────────────────────────

const FIELD_TRIGGER_CLASS =
  "group/field -mx-1.5 flex h-6 w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 text-left text-[11px] text-muted-foreground outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:text-foreground";

const BAND_TRIGGER_CLASS =
  "-mx-1.5 inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-xs outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent/60";

/** Up to three overlapping avatars, then a count. */
function AvatarStack(props: {
  readonly people: ReadonlyArray<{
    readonly login: string;
    readonly avatarUrl?: string | undefined;
    readonly team?: boolean;
  }>;
}) {
  const shown = props.people.slice(0, 3);
  const rest = props.people.length - shown.length;
  return (
    <span className="inline-flex items-center">
      <span className="inline-flex -space-x-1">
        {shown.map((person) =>
          person.team ? (
            <span
              key={person.login}
              className="inline-flex size-[18px] items-center justify-center rounded-full bg-muted text-muted-foreground ring-2 ring-background"
            >
              <UsersIcon className="size-3" aria-hidden />
            </span>
          ) : (
            <ActorAvatar
              key={person.login}
              login={person.login}
              avatarUrl={person.avatarUrl}
              size={18}
              className="rounded-full ring-2 ring-background"
            />
          ),
        )}
      </span>
      {rest > 0 ? (
        <span className="ml-1 text-xs text-muted-foreground tabular-nums">+{rest}</span>
      ) : null}
    </span>
  );
}

function FieldLabel(props: { readonly label: string; readonly editable: boolean }) {
  return (
    <>
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.editable ? (
        <PencilIcon
          aria-hidden
          className="size-3 shrink-0 opacity-0 transition-opacity duration-(--app-motion-duration-chip) group-hover/field:opacity-100 group-focus-visible/field:opacity-100 group-data-popup-open/field:opacity-100 pointer-coarse:opacity-100"
        />
      ) : null}
    </>
  );
}

/**
 * The field's label: a picker trigger when editable, plain text otherwise.
 * A request from elsewhere (the "Request review" button) opens it once.
 *
 * In the band an empty field keeps a quiet "Label +" trigger while it is
 * editable, so the first reviewer, assignee or label can still be added (and
 * a request has a picker to open); read-only empty fields leave the band.
 */
function Field(props: {
  readonly layout: "rail" | "band";
  /** Inline summary for the band (avatars, label dots); null when the field is empty. */
  readonly summary: ReactNode;
  /** A one-click action beside an empty field's band trigger ("Assign yourself"). */
  readonly emptyAction?: ReactNode;
  readonly field: PeopleField;
  readonly label: string;
  readonly placeholder: string;
  readonly canUpdate: boolean;
  readonly selected: ReadonlyArray<string>;
  readonly options: ReadonlyArray<PickerOption>;
  readonly loading: boolean;
  readonly onFirstOpen: () => void;
  readonly onApply: (edit: ListEdit) => void;
  readonly children: ReactNode;
}) {
  const { readerKey } = usePullRequestsPage();
  const [open, setOpen] = useState(false);
  const { onFirstOpen, field, canUpdate } = props;
  useEffect(() => {
    // Every editable field mounts its picker (rail and band alike), so a
    // request is only taken where it can open one.
    if (!canUpdate) return;
    const take = (
      request: ReturnType<typeof usePullRequestRailStore.getState>["pickerRequest"],
    ) => {
      if (!request || request.key !== readerKey || request.field !== field) return;
      usePullRequestRailStore.getState().clearPickerRequest(request.token);
      onFirstOpen();
      setOpen(true);
    };
    take(usePullRequestRailStore.getState().pickerRequest);
    return usePullRequestRailStore.subscribe((state) => take(state.pickerRequest));
  }, [canUpdate, field, onFirstOpen, readerKey]);

  const picker = (triggerClassName: string, trigger: ReactNode) => (
    <PickerPopover
      label={props.label}
      placeholder={props.placeholder}
      selected={props.selected}
      options={props.options}
      loading={props.loading}
      open={open}
      onOpenChange={(next) => {
        if (next) onFirstOpen();
        setOpen(next);
      }}
      onApply={props.onApply}
      triggerClassName={triggerClassName}
    >
      {trigger}
    </PickerPopover>
  );

  if (props.layout === "band") {
    const empty = props.summary === null;
    if (empty && !props.canUpdate) return null;
    const inline = (
      <>
        <span className="text-muted-foreground">{props.label}</span>
        {empty ? (
          <PlusIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          props.summary
        )}
      </>
    );
    if (!props.canUpdate) {
      return <span className="inline-flex h-7 min-w-0 items-center gap-1.5 text-xs">{inline}</span>;
    }
    // One stable trigger whether or not the field is empty, so focus stays put
    // when the first value lands.
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        {picker(BAND_TRIGGER_CLASS, inline)}
        {empty ? props.emptyAction : null}
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {props.canUpdate ? (
        picker(FIELD_TRIGGER_CLASS, <FieldLabel label={props.label} editable />)
      ) : (
        <div className="flex h-6 items-center text-[11px] text-muted-foreground">
          <FieldLabel label={props.label} editable={false} />
        </div>
      )}
      {props.children}
    </div>
  );
}

function EmptyValue(props: { readonly children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{props.children}</p>;
}

/** Candidate reads wait until a picker first opens; most visits never edit. */
function useLazyEnabled() {
  const [enabled, setEnabled] = useState(false);
  const enable = useMemo(() => () => setEnabled(true), []);
  return [enabled, enable] as const;
}

// ── Reviewers ────────────────────────────────────────────────────────

function ReviewerStateGlyph(props: { readonly row: ReviewerRow }) {
  const label = REVIEWER_STATE_LABEL[props.row.state];
  const icon = (() => {
    switch (props.row.state) {
      case "approved":
        return <CheckIcon className="size-3.5 text-success" aria-hidden />;
      case "changes_requested":
        return <FileDiffIcon className="size-3.5 text-destructive" aria-hidden />;
      case "commented":
        return <MessageSquareIcon className="size-3.5 text-muted-foreground" aria-hidden />;
      case "dismissed":
        return <XIcon className="size-3.5 text-muted-foreground/70" aria-hidden />;
      case "requested":
        return <CircleDashedIcon className="size-3.5 text-muted-foreground/70" aria-hidden />;
    }
  })();
  return (
    <span role="img" aria-label={label} title={label} className="inline-flex shrink-0">
      {icon}
    </span>
  );
}

function ReviewersField(props: {
  readonly layout: "rail" | "band";
  readonly canUpdate: boolean;
  readonly viewerLogin: string | null;
  readonly onApply: (edit: ListEdit) => void;
}) {
  const { model } = usePullRequestsPage();
  const selection = usePullRequestSelection();
  const detail = selection.detail.data;
  const [enabled, enable] = useLazyEnabled();
  const candidates = useSourceControlIssueAssignees({
    environmentId: model.environmentId,
    cwd: model.cwd,
    enabled,
  });
  const rows = useMemo(
    () => reviewerRows({ reviewerStates: detail?.reviewerStates, reviewers: detail?.reviewers }),
    [detail?.reviewerStates, detail?.reviewers],
  );
  // GitHub keeps finished reviews on the pull request; only pending requests are editable.
  const requested = useMemo(
    () => rows.filter((row) => row.state === "requested").map((row) => row.login),
    [rows],
  );
  const author = detail?.author ?? null;
  const options = useMemo<ReadonlyArray<PickerOption>>(() => {
    const people = new Map((candidates.data ?? []).map((person) => [person.login, person]));
    const teams = rows.filter((row) => row.kind === "team").map((row) => row.login);
    const reviewed = new Map(
      rows.filter((row) => row.state !== "requested").map((row) => [row.login, row] as const),
    );
    return pickerCandidates({
      offered: [...teams, ...people.keys()],
      selected: requested,
      exclude: author ? [author] : [],
    }).map((login) => {
      const person = people.get(login);
      const past = reviewed.get(login);
      return {
        value: login,
        kind: login.includes("/") ? "team" : "person",
        detail: past ? REVIEWER_STATE_LABEL[past.state] : person?.displayName,
        avatarUrl: person?.avatarUrl ?? past?.avatarUrl,
        trailing: past ? (
          <RotateCcwIcon
            className="size-3 shrink-0 text-muted-foreground"
            aria-label="Re-request"
          />
        ) : undefined,
      } satisfies PickerOption;
    });
  }, [author, candidates.data, requested, rows]);

  return (
    <Field
      layout={props.layout}
      summary={
        rows.length === 0 ? null : (
          <AvatarStack
            people={rows.map((row) => ({
              login: row.login,
              avatarUrl: row.avatarUrl,
              team: row.kind === "team",
            }))}
          />
        )
      }
      field="reviewers"
      label="Reviewers"
      placeholder="Request a reviewer or team"
      canUpdate={props.canUpdate}
      selected={requested}
      options={options}
      loading={candidates.isLoading}
      onFirstOpen={enable}
      onApply={props.onApply}
    >
      {rows.length === 0 ? (
        <EmptyValue>No reviewers</EmptyValue>
      ) : (
        <ul className="flex flex-col">
          {rows.map((row) => (
            <li key={row.login} className="group/person flex h-7 min-w-0 items-center gap-2">
              {row.kind === "team" ? (
                <span className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <UsersIcon className="size-3" aria-hidden />
                </span>
              ) : (
                <ActorAvatar login={row.login} avatarUrl={row.avatarUrl} size={18} />
              )}
              <span className="min-w-0 truncate text-[13px] text-foreground/90">{row.login}</span>
              {row.isCodeOwner ? (
                <span className="shrink-0 text-[11px] text-muted-foreground">Code owner</span>
              ) : null}
              <span className="flex-1" />
              {props.canUpdate && row.canRerequest ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={`Re-request review from ${row.login}`}
                        onClick={() => props.onApply({ add: [row.login], remove: [] })}
                        className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 outline-hidden transition-opacity duration-(--app-motion-duration-chip) group-hover/person:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:opacity-100"
                      />
                    }
                  >
                    <RotateCcwIcon className="size-3" aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup side="left" sideOffset={6}>
                    Re-request review
                  </TooltipPopup>
                </Tooltip>
              ) : null}
              <ReviewerStateGlyph row={row} />
            </li>
          ))}
        </ul>
      )}
    </Field>
  );
}

// ── Assignees ────────────────────────────────────────────────────────

function AssigneesField(props: {
  readonly layout: "rail" | "band";
  readonly canUpdate: boolean;
  readonly viewerLogin: string | null;
  readonly onApply: (edit: ListEdit) => void;
}) {
  const { model } = usePullRequestsPage();
  const selection = usePullRequestSelection();
  const assignees =
    selection.detail.data?.assignees ?? selection.summary?.assignees ?? EMPTY_LOGINS;
  const [enabled, enable] = useLazyEnabled();
  const candidates = useSourceControlIssueAssignees({
    environmentId: model.environmentId,
    cwd: model.cwd,
    enabled,
  });
  const people = useMemo(
    () => new Map((candidates.data ?? []).map((person) => [person.login, person])),
    [candidates.data],
  );
  const options = useMemo<ReadonlyArray<PickerOption>>(
    () =>
      pickerCandidates({ offered: [...people.keys()], selected: assignees }).map((login) => ({
        value: login,
        kind: "person",
        detail: people.get(login)?.displayName,
        avatarUrl: people.get(login)?.avatarUrl,
      })),
    [assignees, people],
  );

  const viewerLogin = props.viewerLogin;
  const assignYourself =
    assignees.length === 0 && props.canUpdate && viewerLogin ? (
      <button
        type="button"
        onClick={() => props.onApply({ add: [viewerLogin], remove: [] })}
        className="-mx-1 self-start rounded px-1 text-xs text-muted-foreground outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        Assign yourself
      </button>
    ) : null;

  return (
    <Field
      layout={props.layout}
      emptyAction={assignYourself}
      summary={
        assignees.length === 0 ? null : (
          <AvatarStack
            people={assignees.map((login) => ({
              login,
              avatarUrl: people.get(login)?.avatarUrl,
            }))}
          />
        )
      }
      field="assignees"
      label="Assignees"
      placeholder="Assign someone"
      canUpdate={props.canUpdate}
      selected={assignees}
      options={options}
      loading={candidates.isLoading}
      onFirstOpen={enable}
      onApply={props.onApply}
    >
      {assignees.length === 0 ? (
        (assignYourself ?? <EmptyValue>No one</EmptyValue>)
      ) : (
        <ul className="flex flex-col">
          {assignees.map((login) => (
            <li key={login} className="flex h-7 min-w-0 items-center gap-2">
              <ActorAvatar login={login} avatarUrl={people.get(login)?.avatarUrl} size={18} />
              <span className="min-w-0 truncate text-[13px] text-foreground/90">
                {login === props.viewerLogin ? "You" : login}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Field>
  );
}

// ── Labels ───────────────────────────────────────────────────────────

/** A label as a hairline pill with its colour as a dot: legible, never a tinted block. */
export function LabelPill(props: {
  readonly label: SourceControlLabel;
  readonly className?: string;
}) {
  return (
    <span
      title={props.label.description ?? props.label.name}
      className={cn(
        "inline-flex h-5 max-w-full items-center gap-1.5 rounded-full border border-border/70 px-2 text-xs text-foreground/85",
        props.className,
      )}
    >
      <LabelDot color={props.label.color} className="size-1.5" />
      <span className="truncate">{props.label.name}</span>
    </span>
  );
}

function LabelsField(props: {
  readonly layout: "rail" | "band";
  readonly canUpdate: boolean;
  readonly onApply: (edit: ListEdit) => void;
}) {
  const { model } = usePullRequestsPage();
  const selection = usePullRequestSelection();
  const labels = selection.detail.data?.labels ?? selection.summary?.labels ?? EMPTY_LABELS;
  const [enabled, enable] = useLazyEnabled();
  const repositoryLabels = useSourceControlIssueLabels({
    environmentId: model.environmentId,
    cwd: model.cwd,
    enabled,
  });
  const selected = useMemo(() => labels.map((label) => label.name), [labels]);
  const options = useMemo<ReadonlyArray<PickerOption>>(() => {
    const known = new Map<string, SourceControlLabel>();
    for (const label of [...labels, ...(repositoryLabels.data ?? [])]) known.set(label.name, label);
    return pickerCandidates({ offered: [...known.keys()], selected }).map((name) => ({
      value: name,
      kind: "label",
      color: known.get(name)?.color,
      detail: known.get(name)?.description,
    }));
  }, [labels, repositoryLabels.data, selected]);

  return (
    <Field
      layout={props.layout}
      summary={
        labels.length === 0 ? null : (
          <span className="inline-flex items-center gap-1" title={selected.join(", ")}>
            {labels.slice(0, 4).map((label) => (
              <LabelDot key={label.name} color={label.color} />
            ))}
            {labels.length > 4 ? (
              <span className="text-xs text-muted-foreground tabular-nums">
                +{labels.length - 4}
              </span>
            ) : null}
          </span>
        )
      }
      field="labels"
      label="Labels"
      placeholder="Filter labels"
      canUpdate={props.canUpdate}
      selected={selected}
      options={options}
      loading={repositoryLabels.isLoading}
      onFirstOpen={enable}
      onApply={props.onApply}
    >
      {labels.length === 0 ? (
        <EmptyValue>None</EmptyValue>
      ) : (
        <div className="flex flex-wrap gap-1">
          {labels.map((label) => (
            <LabelPill key={label.name} label={label} />
          ))}
        </div>
      )}
    </Field>
  );
}
