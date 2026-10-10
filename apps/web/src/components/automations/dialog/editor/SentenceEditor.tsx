/**
 * The sentence: when + where, each value a token that opens its picker.
 *
 *   Every [day] from [tomorrow 09:00] for [30 days] on [This device]
 *   in [a new worktree] off [main]
 *
 * Each connective is glued to its token, so a line never ends on "on" /
 * "for" / "from". Parts that only apply to repeating schedules or to
 * worktree runs stay in place, hidden, and fade in when they apply again.
 */
import type { ScheduleDraft } from "@ryco/client-runtime/state/agentControl";
import type { EnvironmentId, ThreadEnvMode } from "@ryco/contracts";
import { AUTOMATION_LIMITS } from "@ryco/shared/automationSchedule";
import { FolderIcon, GitForkIcon } from "lucide-react";
import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

import { DeviceIcon } from "../../../DeviceIcon";
import { IntervalPicker } from "../../pickers/IntervalPicker";
import { UntilPicker, type UntilVia } from "../../pickers/UntilPicker";
import { WhenField, type WhenVia } from "../../pickers/WhenField";
import { Tip } from "../dialogControls";
import { animateSentenceChange } from "./editorMotion";
import type { EditorTokenKind, SentenceWords } from "./editorModel.logic";
import { RefToken } from "./RefToken";
import { TokenMenu, TokenPopover } from "./tokenPopups";

/** A device a new schedule can go to. */
export interface SentenceDevice {
  readonly key: string;
  readonly label: string;
  readonly environmentId: EnvironmentId;
  /** The checkout's folder, as the list says it ("~/Code/ryco"). */
  readonly path: string;
}

/**
 * What a token's message is, by id (`aria-describedby`): the inline
 * messages for the times, the footer's refusal for the branch.
 */
export type SentenceMessageIds = Partial<Record<"start" | "interval" | "end" | "ref", string>>;

/** The open token, and what was typed on it (a letter on the time token). */
export interface OpenToken {
  readonly kind: EditorTokenKind;
  readonly text: string | null;
}

export interface SentenceEditorProps {
  readonly editorId: string;
  readonly draft: ScheduleDraft;
  readonly words: SentenceWords;
  readonly nowMs: number;
  readonly open: OpenToken | null;
  readonly onOpenChange: (kind: EditorTokenKind, open: boolean) => void;
  readonly onTokenKeyDown: (kind: EditorTokenKind, event: KeyboardEvent<HTMLButtonElement>) => void;
  /** Tokens with a message point at it (`aria-describedby`) and are marked invalid. */
  readonly messageIds: SentenceMessageIds;
  /** The device: a menu for a new schedule on a project with several devices, else plain text. */
  readonly device: SentenceDevice | null;
  readonly devices: readonly SentenceDevice[] | null;
  readonly deviceTip: string | null;
  /** Where the branch list is read (the checkout's folder on its device). */
  readonly refSource: { readonly environmentId: EnvironmentId; readonly cwd: string } | null;
  readonly onInterval: (ms: number) => void;
  readonly onStart: (ms: number) => void;
  readonly onEnd: (ms: number) => void;
  readonly onDevice: (key: string) => void;
  readonly onEnv: (mode: ThreadEnvMode) => void;
  readonly onRef: (ref: string) => void;
  /** A picker accepted a value it closes on (a preset, a typed time): fold it away shortly. */
  readonly onPicked: (kind: EditorTokenKind) => void;
}

const ENV_ITEMS = [
  {
    value: "worktree",
    label: "a new worktree",
    hint: "Each run starts in a fresh worktree off a branch.",
    icon: <GitForkIcon aria-hidden="true" />,
  },
  {
    value: "local",
    label: "the main checkout",
    hint: "Runs edit your checkout directly.",
    icon: <FolderIcon aria-hidden="true" />,
  },
] as const;

function Pair(props: {
  readonly hidden?: boolean;
  readonly m?: string;
  readonly children: ReactNode;
}) {
  return (
    <span className="ae-pair" data-m={props.m} hidden={props.hidden}>
      {props.children}
    </span>
  );
}

export function SentenceEditor(props: SentenceEditorProps) {
  const { editorId, draft, words, open } = props;
  const repeat = draft.kind !== "once";
  const worktree = draft.envMode === "worktree";
  const isOpen = (kind: EditorTokenKind) => open?.kind === kind;
  const tokenProps = (kind: EditorTokenKind) => ({
    type: "button" as const,
    className: "ae-tok",
    "data-tok": kind,
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => props.onTokenKeyDown(kind, event),
  });
  const invalid = (kind: "start" | "interval" | "end") =>
    props.messageIds[kind]
      ? { "data-invalid": "", "aria-invalid": true, "aria-describedby": props.messageIds[kind] }
      : {};

  // A part that applies again fades in; the sentence settles once.
  const sentenceRef = useRef<HTMLFieldSetElement | null>(null);
  const shownRef = useRef<{ readonly repeat: boolean; readonly worktree: boolean } | null>(null);
  useLayoutEffect(() => {
    const previous = shownRef.current;
    shownRef.current = { repeat, worktree };
    const sentence = sentenceRef.current;
    if (!previous || !sentence) return;
    if (previous.repeat === repeat && previous.worktree === worktree) return;
    const appeared = Array.from(sentence.querySelectorAll<HTMLElement>("[data-m]")).filter(
      (part) =>
        part.dataset.m === "repeat" ? repeat && !previous.repeat : worktree && !previous.worktree,
    );
    animateSentenceChange(sentence, appeared);
  }, [repeat, worktree]);

  const onStartChange = (ms: number) => props.onStart(ms);
  const onStartCommit = (
    _ms: number,
    info: { readonly changed: boolean; readonly via: WhenVia },
  ) => {
    if (info.changed && (info.via === "type" || info.via === "suggestion")) props.onPicked("start");
  };
  const onEndCommit = (_ms: number, info: { readonly via: UntilVia }) => {
    if (info.via === "preset" || info.via === "max") props.onPicked("end");
  };

  const device = props.device;
  return (
    <fieldset ref={sentenceRef} className="ae-sentence">
      <legend className="sr-only">When and where it runs</legend>
      <Pair m="repeat" hidden={!repeat}>
        <span className="ae-w">Every</span>{" "}
        <TokenPopover
          editorId={editorId}
          kind="interval"
          title="Repeat every"
          open={isOpen("interval")}
          onOpenChange={(next) => props.onOpenChange("interval", next)}
          initialFocus='[role="radio"][aria-checked="true"]'
          trigger={
            <button
              {...tokenProps("interval")}
              {...invalid("interval")}
              aria-label={words.intervalLabel}
            >
              {words.interval}
            </button>
          }
        >
          <IntervalPicker
            valueMs={draft.intervalMs}
            label="Repeat every"
            onChange={props.onInterval}
            onCommit={() => props.onPicked("interval")}
          />
        </TokenPopover>
      </Pair>{" "}
      <Pair>
        <span className="ae-w">{words.startWord}</span>{" "}
        <TokenPopover
          editorId={editorId}
          kind="start"
          title={draft.kind === "once" ? "Runs at" : "First run"}
          open={isOpen("start")}
          onOpenChange={(next) => props.onOpenChange("start", next)}
          initialFocus=".pk-input"
          trigger={
            <button {...tokenProps("start")} {...invalid("start")} aria-label={words.startLabel}>
              {words.start}
            </button>
          }
        >
          <WhenField
            value={draft.start}
            nowMs={props.nowMs}
            min={props.nowMs}
            max={props.nowMs + AUTOMATION_LIMITS.horizonMs}
            label={draft.kind === "once" ? "Runs at" : "First run"}
            initialText={open?.kind === "start" ? (open.text ?? undefined) : undefined}
            onChange={onStartChange}
            onCommit={onStartCommit}
            className="min-w-[340px]"
          />
        </TokenPopover>
      </Pair>{" "}
      <Pair m="repeat" hidden={!repeat}>
        <span className="ae-w">{words.endWord}</span>{" "}
        <TokenPopover
          editorId={editorId}
          kind="end"
          title="Ends"
          open={isOpen("end")}
          onOpenChange={(next) => props.onOpenChange("end", next)}
          initialFocus='[role="radio"][aria-checked="true"]'
          trigger={
            <button {...tokenProps("end")} {...invalid("end")} aria-label={words.endLabel}>
              {words.end}
            </button>
          }
        >
          <UntilPicker
            startMs={draft.start}
            valueMs={draft.endsAt}
            nowMs={props.nowMs}
            intervalMs={draft.intervalMs}
            label="Ends"
            onChange={props.onEnd}
            onCommit={onEndCommit}
          />
        </TokenPopover>
      </Pair>{" "}
      <Pair>
        <span className="ae-w">on</span>{" "}
        {props.devices && device ? (
          <TokenMenu
            editorId={editorId}
            kind="device"
            label="Device"
            open={isOpen("device")}
            onOpenChange={(next) => props.onOpenChange("device", next)}
            value={device.key}
            items={props.devices.map((candidate) => ({
              value: candidate.key,
              label: candidate.label,
              icon: (
                <DeviceIcon
                  environmentId={candidate.environmentId}
                  label={candidate.label}
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
              ),
              aside: <span className="ad-path">{candidate.path}</span>,
            }))}
            onPick={props.onDevice}
            trigger={
              <button {...tokenProps("device")} aria-label={`Device: ${device.label}`}>
                {device.label}
              </button>
            }
          />
        ) : (
          <Tip label={props.deviceTip}>
            <span className="ae-tok is-static" data-tok-static="device">
              {device?.label ?? "this device"}
            </span>
          </Tip>
        )}
      </Pair>{" "}
      <Pair>
        <span className="ae-w">in</span>{" "}
        <TokenMenu
          editorId={editorId}
          kind="env"
          label="Runs in"
          wide
          open={isOpen("env")}
          onOpenChange={(next) => props.onOpenChange("env", next)}
          value={draft.envMode}
          items={ENV_ITEMS}
          onPick={props.onEnv}
          trigger={
            <button {...tokenProps("env")} aria-label={words.envLabel}>
              {words.env}
            </button>
          }
        />
      </Pair>{" "}
      <Pair m="worktree" hidden={!worktree}>
        <span className="ae-w">off</span>{" "}
        {props.refSource ? (
          <RefToken
            editorId={editorId}
            environmentId={props.refSource.environmentId}
            cwd={props.refSource.cwd}
            value={draft.baseRef}
            display={words.ref}
            label={words.refLabel}
            messageId={props.messageIds.ref}
            open={isOpen("ref")}
            onOpenChange={(next) => props.onOpenChange("ref", next)}
            onPick={props.onRef}
            onTokenKeyDown={(event) => props.onTokenKeyDown("ref", event)}
          />
        ) : (
          <span className="ae-tok ae-tok-ref is-static">{words.ref}</span>
        )}
      </Pair>
    </fieldset>
  );
}
