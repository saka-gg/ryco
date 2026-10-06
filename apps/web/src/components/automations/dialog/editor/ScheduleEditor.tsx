/**
 * The schedule editor (the lab's direction C): the detail turns into a
 * sentence editor in place. The title is the header; Repeats | Once sits
 * beside it; the sentence says when and where, each value a token that opens
 * its picker under the sentence; the next runs follow; model and permissions
 * sit on one quiet line above the prompt. Problems are said inline, each
 * with a one-click fix where there is one. The footer says what saving
 * means ("Nothing runs until you approve it."), asks before a dirty draft is
 * thrown away, and saves for approval (⌘↵).
 *
 * The host (`AutomationsDialog`) routes Escape and closing, keeps the undo
 * bar, and lands a saved draft on its row; see `editorContract.ts`.
 */
import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import {
  blankScheduleDraft,
  definitionFromDraft,
  draftSchedule,
  scheduleDraftKey,
  scheduleDraftMessages,
  validateScheduleDraft,
  type ScheduleDraft,
} from "@ryco/client-runtime/state/agentControl";
import { AgentControlAutomationId } from "@ryco/contracts";
import { AUTOMATION_LIMITS } from "@ryco/shared/automationSchedule";
import { CircleAlertIcon, Repeat2Icon } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { useEvent } from "../../../../hooks/useEvent";
import { cn, isMacPlatform, randomUUID } from "../../../../lib/utils";
import { selectSidebarWorktreesForProjectRef, useStore } from "../../../../store";
import { formatProjectPath, inferHomeDirectory } from "../../../projects/projectsModel.logic";
import { Textarea } from "../../../ui/textarea";
import { toastManager } from "../../../ui/toast";
import type { ProjectAutomationsCheckout } from "../../data/useProjectAutomations";
import { PickerRadioRow } from "../../pickers/PickerRadioRow";
import { RunPreview } from "../../pickers/RunPreview";
import { DialogButton } from "../dialogControls";
import type { ScheduleEditorDraftState, ScheduleEditorSlotProps } from "../editorContract";
import { AgentPicks } from "./AgentPicks";
import {
  applyDraftFix,
  defaultScheduleModel,
  editorHint,
  editorOpening,
  emptyModelSelection,
  firstInvalidField,
  modelMissing,
  promptCount,
  SAVE_REFUSED,
  saveFailureField,
  sentenceWords,
  withStart,
  type EditorFocusField,
  type EditorTokenKind,
} from "./editorModel.logic";
import { animateEditorIn } from "./editorMotion";
import {
  SentenceEditor,
  type OpenToken,
  type SentenceDevice,
  type SentenceMessageIds,
} from "./SentenceEditor";
import { findEditorToken } from "./tokenAnchor";

type CommandInput = Parameters<ProjectAutomationsCheckout["command"]>[0];

/** Saving checks against the real clock (the server does), not the dialog's minute. */
const readClock = () => Date.now();

/** A picker that accepted a value folds away this long after (the lab's 170 ms). */
const CLOSE_SOON_MS = 170;

const KIND_OPTIONS = [
  {
    value: "fixed-interval",
    label: (
      <>
        <Repeat2Icon className="pk-ic" aria-hidden="true" />
        Repeats
      </>
    ),
  },
  { value: "once", label: "Once" },
] as const;

/** The branch a new worktree run starts off: the checkout's own branch, else "main". */
function useMainBranch(checkout: ProjectAutomationsCheckout | undefined): string {
  const environmentId = checkout?.environmentId ?? null;
  const projectId = checkout?.projectId ?? null;
  return useStore((state) => {
    if (!environmentId || !projectId) return "main";
    const worktrees = selectSidebarWorktreesForProjectRef(
      state,
      scopeProjectRef(environmentId, projectId),
    );
    return worktrees.find((worktree) => worktree.origin === "main")?.branch ?? "main";
  });
}

function blankFor(
  checkout: {
    readonly projectId: ScheduleDraft["projectId"];
    readonly providers: ProjectAutomationsCheckout["providers"];
  },
  nowMs: number,
  baseRef: string,
): ScheduleDraft {
  return blankScheduleDraft({
    projectId: checkout.projectId,
    nowMs,
    modelSelection: defaultScheduleModel(checkout.providers) ?? emptyModelSelection(),
    baseRef,
  });
}

export function ScheduleEditor(props: ScheduleEditorSlotProps) {
  const { checkouts, nowMs, source } = props;
  const editorId = useId();
  const startKey =
    source.kind === "restore" ? source.state.checkoutKey : (source.checkoutKey ?? null);
  const openingCheckout = checkouts.find((candidate) => candidate.key === startKey) ?? checkouts[0];
  const mainBranch = useMainBranch(openingCheckout);

  // ── the draft ──────────────────────────────────────────────────────
  const [opening] = useState(() =>
    editorOpening({
      source,
      checkouts,
      nowMs,
      defaultBaseRef: mainBranch,
      fallbackProjectId: props.project.id,
      blank: (checkout) => blankFor(checkout, nowMs, mainBranch),
    }),
  );
  const isNew = opening.isNew;
  const [draft, setDraft] = useState(opening.draft);
  const [initialKey, setInitialKey] = useState(opening.initialKey);
  const [checkoutKey, setCheckoutKey] = useState(opening.checkoutKey);
  const [attempted, setAttempted] = useState(false);
  const [touched, setTouched] = useState({ title: false, prompt: false });
  const [modelChosen, setModelChosen] = useState(false);
  const [saving, setSaving] = useState(false);
  /** The last save was refused; its reason shows until the draft changes. */
  const [refused, setRefused] = useState(false);
  const [open, setOpen] = useState<OpenToken | null>(null);

  const checkout = checkouts.find((candidate) => candidate.key === checkoutKey);
  const providers = checkout?.providers ?? [];

  // A new draft opened before the device's providers arrived takes their
  // default model once they do; it stays a clean draft.
  if (isNew && !modelChosen && modelMissing(draft.modelSelection)) {
    const fallback = defaultScheduleModel(providers);
    if (fallback) {
      const next = { ...draft, modelSelection: fallback };
      if (scheduleDraftKey(draft) === initialKey) setInitialKey(scheduleDraftKey(next));
      setDraft(next);
    }
  }

  const dirty = scheduleDraftKey(draft) !== initialKey;
  const stateOf = (next: ScheduleDraft, key: string): ScheduleEditorDraftState => {
    const nextDirty = scheduleDraftKey(next) !== initialKey;
    return { checkoutKey: key, draft: next, initialKey, isNew, dirty: nextDirty };
  };
  /** Every change goes through here: the host keeps the latest draft for Restore. */
  const update = (next: ScheduleDraft, key: string = checkoutKey) => {
    setDraft(next);
    setRefused(false);
    const state = stateOf(next, key);
    props.onDirtyChange(state.dirty, state);
  };
  const reportOpened = useEffectEvent(() => {
    const state = stateOf(draft, checkoutKey);
    props.onDirtyChange(state.dirty, state);
  });
  useEffect(() => reportOpened(), []);

  // ── what it says ───────────────────────────────────────────────────
  const words = sentenceWords(draft, nowMs);
  const validation = validateScheduleDraft(draft, {
    nowMs,
    snapshot: checkout?.snapshot ?? null,
    ...(providers.length ? { providers } : {}),
    projectName: props.project.displayName,
  });
  const errors = validation.errors;
  const messages = scheduleDraftMessages(draft, errors, {
    nowMs,
    attempted,
    titleTouched: touched.title,
  });
  const messageId = (key: string) => `${editorId}-msg-${key}`;
  const hintId = `${editorId}-hint`;
  const modelErrorId = `${editorId}-model-err`;
  // Why the last save was refused: what the device said, else why it can't take one.
  const failure = refused ? (checkout?.disabledReason ?? checkout?.error ?? SAVE_REFUSED) : null;
  const failureField = saveFailureField(failure);
  const messageIds: SentenceMessageIds = {};
  for (const message of messages)
    if (message.key !== "title") messageIds[message.key] = messageId(message.key);
  if (failureField === "ref") messageIds.ref = hintId;
  const titleInvalid = !!errors.title && (attempted || touched.title);
  const promptError = attempted || touched.prompt ? (errors.prompt ?? "") : "";
  const hint = editorHint({ confirm: props.confirm, failure, limit: errors.limit, isNew });
  const count = promptCount(draft.prompt.length, AUTOMATION_LIMITS.promptMax);
  const mac = typeof navigator !== "undefined" && isMacPlatform(navigator.platform);

  // A new schedule can only go to a device whose schedules could be read.
  const devices: SentenceDevice[] = checkouts
    .filter((candidate) => candidate.snapshot !== null || candidate.key === checkoutKey)
    .map((candidate) => ({
      key: candidate.key,
      label: candidate.deviceLabel,
      environmentId: candidate.environmentId,
      path: formatProjectPath(candidate.member.cwd, inferHomeDirectory(candidate.member.cwd)),
    }));
  const device = devices.find((candidate) => candidate.key === checkoutKey) ?? null;

  // ── refs (read in handlers and effects only) ───────────────────────
  const contentRef = useRef<HTMLDivElement | null>(null);
  const headRef = useRef<HTMLElement | null>(null);
  const footerRef = useRef<HTMLElement | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  // The entrance, and focus: the title (caret at its end) or the model pick.
  const enter = useEffectEvent(() => {
    const content = contentRef.current;
    const head = headRef.current;
    const footer = footerRef.current;
    if (content && head && footer)
      animateEditorIn({
        content,
        head,
        footer,
        origin: props.origin,
        fromDetail: props.fromDetail,
      });
    if (props.focus === "model") {
      findEditorToken(editorId, "model")?.focus({ preventScroll: true });
      return;
    }
    const title = titleRef.current;
    if (!title) return;
    title.focus({ preventScroll: true });
    title.setSelectionRange(title.value.length, title.value.length);
  });
  useLayoutEffect(() => enter(), []);

  // ── tokens ─────────────────────────────────────────────────────────
  // A picker folding away shortly after it accepted a value; one at a time,
  // dropped when another token opens or the editor goes.
  const closeSoonRef = useRef<number | null>(null);
  const cancelCloseSoon = () => {
    if (closeSoonRef.current !== null) window.clearTimeout(closeSoonRef.current);
    closeSoonRef.current = null;
  };
  useEffect(() => {
    const timer = closeSoonRef;
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);
  const setTokenOpen = (kind: EditorTokenKind, next: boolean) => {
    if (next) cancelCloseSoon();
    setOpen((current) => (next ? { kind, text: null } : current?.kind === kind ? null : current));
  };
  const closeSoon = (kind: EditorTokenKind) => {
    cancelCloseSoon();
    closeSoonRef.current = window.setTimeout(() => {
      closeSoonRef.current = null;
      setOpen((current) => (current?.kind === kind ? null : current));
    }, CLOSE_SOON_MS);
  };
  /** ↓ opens a token; a letter on the time token opens it with that letter typed. */
  const onTokenKeyDown = (kind: EditorTokenKind, event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      cancelCloseSoon();
      setOpen({ kind, text: null });
    } else if (kind === "start" && event.key.length === 1 && event.key !== " ") {
      event.preventDefault();
      cancelCloseSoon();
      setOpen({ kind, text: event.key });
    }
  };

  const setKind = (kind: ScheduleDraft["kind"]) => {
    if (draft.kind === kind) return;
    setOpen(null);
    update({ ...draft, kind });
  };

  const onFix = (key: "start" | "interval" | "end" | "title", value: number) => {
    // Focus moves to the token first, so the fix button can go.
    if (key === "title") titleRef.current?.focus({ preventScroll: true });
    else findEditorToken(editorId, key)?.focus({ preventScroll: true });
    update(applyDraftFix(draft, key, value));
  };

  const focusField = (field: EditorFocusField) => {
    if (field === "title") return titleRef.current?.focus();
    if (field === "prompt") return promptRef.current?.focus();
    if (field === "model") return findEditorToken(editorId, "model")?.focus();
    const fix = document.querySelector<HTMLElement>(
      `[data-ae-ed="${CSS.escape(editorId)}"] .ae-msg[data-for="${field}"] .ae-fix`,
    );
    (fix ?? findEditorToken(editorId, field))?.focus();
  };

  // ── save ───────────────────────────────────────────────────────────
  const save = useEvent(async () => {
    if (saving) return;
    // The server checks against the real clock, not the dialog's minute.
    const current = validateScheduleDraft(draft, {
      nowMs: readClock(),
      snapshot: checkout?.snapshot ?? null,
      ...(providers.length ? { providers } : {}),
      projectName: props.project.displayName,
    });
    if (current.errors.limit) return;
    if (!current.ok) {
      setAttempted(true);
      const field = firstInvalidField(current.errors);
      if (field) focusField(field);
      return;
    }
    if (!dirty && !isNew) {
      props.onClose("unchanged");
      toastManager.add({ type: "info", title: "Nothing changed, so nothing was proposed." });
      return;
    }
    if (!checkout || checkout.busy || checkout.disabledReason) {
      setRefused(true);
      toastManager.add({ type: "error", title: SAVE_REFUSED });
      return;
    }
    const automationId = draft.id ?? AgentControlAutomationId.make(randomUUID());
    const expectedRevision =
      (draft.id &&
        checkout.snapshot?.automations.find((automation) => automation.automationId === draft.id)
          ?.revision) ??
      null;
    const input: CommandInput = {
      kind: "save",
      projectId: draft.projectId,
      automationId,
      expectedRevision,
      definition: definitionFromDraft(draft),
    };
    setSaving(true);
    setRefused(false);
    const ok = await checkout.command(input);
    setSaving(false);
    if (!ok) {
      // The footer says why (the device's reason lands in `checkout.error`).
      setRefused(true);
      toastManager.add({ type: "error", title: SAVE_REFUSED });
      return;
    }
    props.onSaved({
      checkoutKey: checkout.key,
      automationId,
      fromRect: titleRef.current?.getBoundingClientRect() ?? null,
    });
  });

  const onEditorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys typed in a portaled popover bubble here through React; they are the popover's.
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void save();
    }
  };

  const refSource = checkout
    ? { environmentId: checkout.environmentId, cwd: checkout.member.cwd }
    : null;

  return (
    <div className="contents" data-ae-ed={editorId} onKeyDown={onEditorKeyDown}>
      <div className="ad-ed-scroll">
        <div ref={contentRef} className="ad-ed-in">
          <header ref={headRef} className="ad-dh ad-ed-h">
            <div className="ad-dh-t">
              <input
                ref={titleRef}
                className="ae-title-in"
                type="text"
                aria-label="Title"
                placeholder="Name this schedule"
                maxLength={AUTOMATION_LIMITS.titleMax}
                spellCheck={false}
                autoComplete="off"
                value={draft.title}
                data-invalid={titleInvalid ? "" : undefined}
                aria-invalid={titleInvalid}
                aria-describedby={titleInvalid ? messageId("title") : undefined}
                onChange={(event) => update({ ...draft, title: event.target.value })}
                onBlur={() => {
                  if (draft.title.trim()) setTouched((current) => ({ ...current, title: true }));
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.metaKey || event.ctrlKey) return;
                  event.preventDefault();
                  findEditorToken(editorId, draft.kind === "once" ? "start" : "interval")?.focus();
                }}
              />
            </div>
            <div className="ad-dh-x">
              <span className="pk">
                <PickerRadioRow
                  options={KIND_OPTIONS}
                  value={draft.kind}
                  label="How often"
                  className="ae-kind"
                  onSelect={setKind}
                />
              </span>
            </div>
          </header>
          <SentenceEditor
            editorId={editorId}
            draft={draft}
            words={words}
            nowMs={nowMs}
            open={open}
            onOpenChange={setTokenOpen}
            onTokenKeyDown={onTokenKeyDown}
            messageIds={messageIds}
            device={device}
            devices={isNew && devices.length > 1 ? devices : null}
            deviceTip={isNew ? null : "A schedule stays on the device it was created on"}
            refSource={refSource}
            onInterval={(ms) => update({ ...draft, intervalMs: ms })}
            onStart={(ms) => update(withStart(draft, ms))}
            onEnd={(ms) => update({ ...draft, endsAt: ms })}
            onDevice={(key) => {
              const next = checkouts.find((candidate) => candidate.key === key);
              if (!next || key === checkoutKey) return;
              setCheckoutKey(key);
              update({ ...draft, projectId: next.projectId }, key);
            }}
            onEnv={(mode) => update({ ...draft, envMode: mode })}
            onRef={(ref) => update({ ...draft, baseRef: ref })}
            onPicked={closeSoon}
          />
          <div className="ae-msgs" aria-live="polite">
            {messages.map((message) => (
              <p
                key={message.key}
                id={messageId(message.key)}
                className="ae-msg"
                data-for={message.key}
              >
                <CircleAlertIcon aria-hidden="true" />
                <span className="ae-msg-t">{message.text}</span>
                {message.fix ? (
                  <button
                    type="button"
                    className="ae-fix"
                    data-fix={message.key}
                    onClick={() => {
                      if (message.fix) onFix(message.key, message.fix.value);
                    }}
                  >
                    {message.fix.label}
                  </button>
                ) : null}
              </p>
            ))}
          </div>
          <div className="ae-pv">
            <RunPreview
              schedule={draftSchedule(draft)}
              nowMs={nowMs}
              title="Next runs"
              visibleRows={2}
            />
          </div>
          <AgentPicks
            editorId={editorId}
            selection={draft.modelSelection}
            runtimeMode={draft.runtimeMode}
            providers={providers}
            modelInvalid={!!errors.model || failureField === "model"}
            modelMessageId={
              errors.model ? modelErrorId : failureField === "model" ? hintId : undefined
            }
            openKind={open?.kind ?? null}
            onOpenChange={setTokenOpen}
            onTokenKeyDown={onTokenKeyDown}
            onModel={(selection) => {
              setModelChosen(true);
              update({ ...draft, modelSelection: selection });
            }}
            onRuntimeMode={(mode) => update({ ...draft, runtimeMode: mode })}
          />
          {errors.model ? (
            <p className="ae-ferr" id={modelErrorId} data-for="model">
              {errors.model}
            </p>
          ) : null}
          <div className="ae-fld">
            <div className="ae-fld-h">
              <label className="ae-label" htmlFor={`${editorId}-prompt`}>
                Prompt
              </label>
              <span
                className="ae-count tnum"
                data-over={draft.prompt.length > AUTOMATION_LIMITS.promptMax ? "" : undefined}
              >
                {count}
              </span>
            </div>
            <Textarea
              ref={promptRef}
              id={`${editorId}-prompt`}
              className="ae-prompt"
              rows={5}
              placeholder="What should the agent do on each run?"
              value={draft.prompt}
              aria-invalid={!!promptError}
              aria-describedby={promptError ? `${editorId}-prompt-err` : undefined}
              onChange={(event) => update({ ...draft, prompt: event.target.value })}
              onBlur={() => {
                if (draft.prompt.trim()) setTouched((current) => ({ ...current, prompt: true }));
              }}
            />
            {promptError ? (
              <p className="ae-ferr" id={`${editorId}-prompt-err`} data-for="prompt">
                {promptError}
              </p>
            ) : null}
          </div>
        </div>
      </div>
      <footer ref={footerRef} className="ad-ed-foot">
        <p
          id={hintId}
          className="ad-ed-hint"
          aria-live="polite"
          data-confirm={hint.kind === "confirm" ? "" : undefined}
          data-limit={hint.kind === "limit" ? "" : undefined}
          data-failed={hint.kind === "failed" ? "" : undefined}
        >
          {hint.kind === "limit" || hint.kind === "failed" ? (
            <CircleAlertIcon aria-hidden="true" />
          ) : null}
          <span>{hint.text}</span>
          {hint.kind === "confirm" ? (
            <button
              type="button"
              className="ad-link"
              data-act="keep-editing"
              onClick={() => {
                props.onKeepEditing();
                titleRef.current?.focus({ preventScroll: true });
              }}
            >
              keep editing
            </button>
          ) : null}
        </p>
        <DialogButton
          tone="quiet"
          dataAct="discard"
          className={cn("ae-discard", props.confirm && "ae-discard-confirm")}
          onAction={() => props.onClose("discard")}
        >
          Discard
        </DialogButton>
        <DialogButton
          tone="primary"
          dataAct="save"
          disabled={!!errors.limit || saving}
          onAction={() => void save()}
        >
          Save for approval
          <span className="ae-kbd-in" aria-hidden="true">
            {mac ? "⌘↵" : "Ctrl ↵"}
          </span>
        </DialogButton>
      </footer>
    </div>
  );
}
