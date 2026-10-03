import type {
  ChangeRequest,
  SourceControlProviderInfo,
  VcsRef,
  VcsStatusResult,
} from "@ryco/contracts";
import {
  describeUnsupportedChangeRequestRequest,
  getChangeRequestHostCapabilities,
  resolveChangeRequestPresentation,
  type ChangeRequestHostCapabilities,
  type ChangeRequestPresentation,
} from "@ryco/shared/sourceControl";
import { CircleAlertIcon } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type RefObject } from "react";

import { cn } from "../../../lib/utils";
import { refreshGitStatus, useGitBranches, useGitStatus } from "../../../rpc/useGit";
import {
  useCreateChangeRequestMutation,
  useSourceControlChangeRequestList,
} from "../../../rpc/useSourceControl";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Spinner } from "../../ui/spinner";
import { toastManager } from "../../ui/toast";
import {
  COMPOSER_BOX_CLASS,
  COMPOSER_TEXTAREA_CLASS,
  errorText,
  SubmitKeyHint,
} from "../conversation/MarkdownEditor";
import { PULL_REQUESTS_LIST_LIMIT } from "../pullRequestsModel.logic";
import { BranchPicker } from "./BranchPicker";
import {
  buildCreatePullRequestInput,
  defaultBaseBranch,
  defaultHeadBranch,
  describeCreatePullRequestNotice,
  findOpenChangeRequest,
  needsRemoteLookup,
  resolveHeadPushState,
  validateCreatePullRequest,
  type CreatePullRequestBranch,
  type CreatePullRequestNotice,
} from "./createPullRequest.logic";
import type { CreatePullRequestTarget } from "./createPullRequestDialogStore";
import { useRemoteBranchPresence } from "./useRemoteBranchPresence";

export interface CreatePullRequestDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The checkout to open from; null renders nothing inside the (closed) dialog. */
  readonly target: CreatePullRequestTarget | null;
  /**
   * The host and what it implements, when the caller already knows them (the
   * page's model). Elsewhere both come from the checkout's git status.
   */
  readonly provider?: SourceControlProviderInfo | null | undefined;
  readonly capabilities?: ChangeRequestHostCapabilities | undefined;
  /** The host created it: show it (the dialog has toasted and expects to close). */
  readonly onCreated: (changeRequest: ChangeRequest) => void;
  /** "Open" on the already-open notice. */
  readonly onOpenExisting: (number: number) => void;
}

function sentenceCase(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

/**
 * "New pull request": head and base branches, title, Markdown description,
 * and (where the host has drafts) "Create as draft". Create (⌘↵) stays off
 * until the branches differ, the head is on the remote, no request is already
 * open between them, and there is a title. Host errors stay inline.
 */
export function CreatePullRequestDialog(props: CreatePullRequestDialogProps) {
  // Each opening starts from a fresh form; the closing popup keeps the last one.
  const [generation, setGeneration] = useState(0);
  const [wasOpen, setWasOpen] = useState(props.open);
  if (props.open !== wasOpen) {
    setWasOpen(props.open);
    if (props.open) setGeneration((value) => value + 1);
  }
  const titleRef = useRef<HTMLInputElement | null>(null);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-xl" showCloseButton={false} initialFocus={titleRef}>
        {props.target ? (
          <CreatePullRequestForm
            key={generation}
            {...props}
            target={props.target}
            titleRef={titleRef}
            onClose={() => props.onOpenChange(false)}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function CreatePullRequestForm(
  props: CreatePullRequestDialogProps & {
    readonly target: CreatePullRequestTarget;
    readonly titleRef: RefObject<HTMLInputElement | null>;
    readonly onClose: () => void;
  },
) {
  const { environmentId, cwd, repositoryName } = props.target;
  const status = useGitStatus({ environmentId, cwd });
  const statusData = status.data;
  const provider =
    props.provider !== undefined ? props.provider : (statusData?.sourceControlProvider ?? null);
  const capabilities =
    props.capabilities ?? getChangeRequestHostCapabilities(provider?.kind ?? "unknown");
  const presentation = resolveChangeRequestPresentation(provider);
  // Outside the page the host is known once git status reports it.
  const hostPending = props.capabilities === undefined && provider === null && status.isPending;
  const heading = `New ${presentation.longName}`;

  if (!hostPending && !capabilities.create.supported) {
    return (
      <>
        <DialogHeader>
          <DialogTitle className="text-base">{heading}</DialogTitle>
          <DialogDescription>{repositoryName}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <p className="text-sm text-muted-foreground">
            {describeUnsupportedChangeRequestRequest(provider?.kind ?? "unknown", {
              operation: "createChangeRequest",
            }) ?? `Ryco can't open ${presentation.pluralLongName} here.`}
          </p>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={props.onClose}>
            Close
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <CreatePullRequestFields
      {...props}
      heading={heading}
      presentation={presentation}
      capabilities={capabilities}
      hostPending={hostPending}
      status={statusData}
    />
  );
}

function CreatePullRequestFields(props: {
  readonly target: CreatePullRequestTarget;
  readonly titleRef: RefObject<HTMLInputElement | null>;
  readonly heading: string;
  readonly presentation: ChangeRequestPresentation;
  readonly capabilities: ChangeRequestHostCapabilities;
  readonly hostPending: boolean;
  readonly status: VcsStatusResult | null;
  readonly onClose: () => void;
  readonly onCreated: (changeRequest: ChangeRequest) => void;
  readonly onOpenExisting: (number: number) => void;
}) {
  const { target, presentation, capabilities, status, titleRef, onClose, onCreated } = props;
  const { environmentId, cwd } = target;

  // ── Branches: the checkout's branch into the default one, until picked ──
  const branches = useGitBranches({ environmentId, cwd, query: "" });
  const [pickedHead, setPickedHead] = useState<CreatePullRequestBranch | null>(null);
  const [pickedBase, setPickedBase] = useState<CreatePullRequestBranch | null>(null);
  const head = pickedHead ?? defaultHeadBranch({ status, refs: branches.refs });
  const base = pickedBase ?? defaultBaseBranch({ refs: branches.refs, head: head?.name ?? null });
  const remote = useRemoteBranchPresence({
    environmentId,
    cwd,
    branch: head && needsRemoteLookup(head, status) ? head.name : null,
  });
  const pushState = resolveHeadPushState({ head, status, remote: remote.presence });
  const openRequests = useSourceControlChangeRequestList({
    environmentId,
    cwd,
    state: "open",
    limit: PULL_REQUESTS_LIST_LIMIT,
  });
  const existing = findOpenChangeRequest({
    rows: openRequests.data,
    head: head?.name ?? null,
    base: base?.name ?? null,
  });

  // ── Fields ──
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const validation = validateCreatePullRequest({ head, base, title, pushState, existing });
  const create = useCreateChangeRequestMutation({ environmentId });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = validation.canSubmit && !pending && !props.hostPending;
  const asDraft = draft && capabilities.create.draft;

  const submit = async () => {
    if (!canSubmit || !head || !base) return;
    setPending(true);
    setError(null);
    try {
      const created = await create.mutateAsync(
        buildCreatePullRequestInput({ cwd, head, base, title, body, draft, capabilities }),
      );
      toastManager.add({
        type: "success",
        title: `${sentenceCase(presentation.longName)} #${created.number} opened`,
        description: created.title,
      });
      onCreated(created);
    } catch (submitError) {
      setError(errorText(submitError, `Could not open the ${presentation.longName}.`));
      setPending(false);
    }
  };

  const recheck = () => {
    remote.recheck();
    void refreshGitStatus({ environmentId, cwd });
  };

  // ⌘↵ anywhere in the form (not in a branch list, which is portaled out of it).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) {
      return;
    }
    if (!event.currentTarget.contains(event.target as Node)) return;
    event.preventDefault();
    if (!canSubmit && validation.notice?.tone !== "blocker" && title.trim().length === 0) {
      // The one gap the form can't show by itself: point at the empty title.
      titleRef.current?.focus();
      return;
    }
    void submit();
  };

  const changeHead = (branch: CreatePullRequestBranch) => {
    setPickedHead(branch);
    setError(null);
  };
  const changeBase = (branch: CreatePullRequestBranch) => {
    setPickedBase(branch);
    setError(null);
  };

  return (
    <div className="flex min-h-0 flex-col" onKeyDown={onKeyDown}>
      <DialogHeader className="gap-1 pb-3">
        <DialogTitle className="text-base">{props.heading}</DialogTitle>
        <DialogDescription>{target.repositoryName}</DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-3" scrollFade={false}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px] text-muted-foreground">
          <span>From</span>
          <BranchPicker
            label="Head branch"
            environmentId={environmentId}
            cwd={cwd}
            value={head}
            onChange={changeHead}
            tagFor={headTag}
            placeholder={branches.isPending ? "Loading…" : "Pick a branch"}
          />
          <span>into</span>
          <BranchPicker
            label="Base branch"
            environmentId={environmentId}
            cwd={cwd}
            value={base}
            onChange={changeBase}
            tagFor={baseTag}
            placeholder={branches.isPending ? "Loading…" : "Pick a base"}
          />
        </div>
        {validation.notice ? (
          <NoticeLine
            notice={validation.notice}
            presentation={presentation}
            onOpenExisting={props.onOpenExisting}
            onRecheck={recheck}
          />
        ) : null}
        <div className={COMPOSER_BOX_CLASS}>
          <input
            ref={titleRef}
            type="text"
            aria-label="Title"
            placeholder="Title"
            autoComplete="off"
            value={title}
            disabled={pending}
            onChange={(event) => {
              setTitle(event.target.value);
              setError(null);
            }}
            className="block h-9 w-full bg-transparent px-3 text-sm font-medium text-foreground outline-none placeholder:font-normal placeholder:text-muted-foreground/70 disabled:opacity-64"
          />
        </div>
        <div className={COMPOSER_BOX_CLASS}>
          <textarea
            aria-label="Description"
            placeholder="Describe the change. Markdown works."
            value={body}
            disabled={pending}
            onChange={(event) => setBody(event.target.value)}
            className={cn(COMPOSER_TEXTAREA_CLASS, "min-h-36")}
          />
        </div>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter variant="bare" className="sm:items-center">
        {capabilities.create.draft ? (
          <label className="mr-auto flex cursor-default items-center gap-2 text-[13px] text-muted-foreground">
            <Checkbox
              checked={draft}
              disabled={pending}
              onCheckedChange={(checked) => setDraft(checked === true)}
            />
            Create as draft
          </label>
        ) : null}
        <Button variant="ghost" disabled={pending} onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={!canSubmit} aria-keyshortcuts="Meta+Enter" onClick={() => void submit()}>
          {pending ? <Spinner className="size-3.5" /> : null}
          {asDraft ? "Create draft" : "Create"}
          <SubmitKeyHint />
        </Button>
      </DialogFooter>
    </div>
  );
}

function headTag(ref: VcsRef): string | null {
  return ref.current ? "current" : null;
}

function baseTag(ref: VcsRef): string | null {
  return ref.isDefault ? "default" : null;
}

function NoticeLine(props: {
  readonly notice: CreatePullRequestNotice;
  readonly presentation: ChangeRequestPresentation;
  readonly onOpenExisting: (number: number) => void;
  readonly onRecheck: () => void;
}) {
  const { notice } = props;
  const blocker = notice.tone === "blocker";
  return (
    <div
      role="status"
      className={cn(
        "flex min-h-6 items-center gap-1.5 text-xs",
        blocker ? "text-foreground/85" : "text-muted-foreground",
      )}
    >
      {notice.kind === "checking" ? (
        <Spinner aria-hidden className="size-3 shrink-0" />
      ) : blocker ? (
        <CircleAlertIcon aria-hidden className="size-3.5 shrink-0 text-warning" />
      ) : null}
      <span className="min-w-0">{describeCreatePullRequestNotice(notice, props.presentation)}</span>
      {notice.kind === "already-open" ? (
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto shrink-0"
          onClick={() => props.onOpenExisting(notice.number)}
        >
          Open
        </Button>
      ) : notice.kind === "unpushed" ? (
        <Button size="xs" variant="ghost" className="ml-auto shrink-0" onClick={props.onRecheck}>
          Check again
        </Button>
      ) : null}
    </div>
  );
}
