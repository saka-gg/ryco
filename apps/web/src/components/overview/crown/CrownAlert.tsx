import {
  BotIcon,
  CircleCheckIcon,
  CircleXIcon,
  CloudDownloadIcon,
  CloudUploadIcon,
  GitCommitHorizontalIcon,
  GitPullRequestIcon,
  NotebookPenIcon,
  SparklesIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";
import { useLayoutEffect, useRef, type MouseEvent, type Ref } from "react";

import { Spinner } from "~/components/ui/spinner";

import type { CrownEvent, CrownEventIcon } from "./crownAlerts.logic";

type AlertIconKey = CrownEventIcon | "danger" | "success";

const ALERT_ICON: Record<AlertIconKey, LucideIcon> = {
  danger: CircleXIcon,
  success: CircleCheckIcon,
  x: CircleXIcon,
  check: CircleCheckIcon,
  upload: CloudUploadIcon,
  commit: GitCommitHorizontalIcon,
  bot: BotIcon,
  workflow: WorkflowIcon,
  pr: GitPullRequestIcon,
  sparkles: SparklesIcon,
  turn: CircleCheckIcon,
  note: NotebookPenIcon,
  pull: CloudDownloadIcon,
};

/** Prototype `alertHTML`: the tone decides first (danger ✕, success ✓), then the event kind. */
function alertIconKey(event: CrownEvent): AlertIconKey {
  if (event.tone === "danger" || event.tone === "success") return event.tone;
  return event.icon;
}

/** Prototype `Crown.next()`: the next queued alert rises into place. */
const ALERT_SWAP_KEYFRAMES: Keyframe[] = [
  { opacity: 0, transform: "translateY(8px)", filter: "blur(4px)" },
  { opacity: 1, transform: "none", filter: "blur(0px)" },
];
const ALERT_SWAP_TIMING: KeyframeAnimationOptions = {
  duration: 400,
  easing: "cubic-bezier(.16,1,.3,1)",
};

/**
 * The crown's alert layer: tone icon, title, "<sub> · just now" and View.
 * It keeps rendering the last alert after the crown folds back, so the
 * cross-fade never shows an empty layer. Clicking anywhere opens the card on
 * the alert's section; View is the keyboard-reachable control for the same.
 * An alert with an action (a git result's "View PR") offers it in View's place,
 * and a live one (a git action still running) spins until its result lands.
 * While focus is inside, `onFocusWithinChange` lets the crown hold the alert.
 */
export function CrownAlert({
  ref,
  ...props
}: {
  readonly alert: CrownEvent | null;
  /** Shown when the alert has no sub line (the branch name, as in the prototype). */
  readonly fallbackSub: string;
  readonly visible: boolean;
  readonly reducedMotion: boolean;
  readonly onOpen: (event: MouseEvent<HTMLElement>) => void;
  /** Runs the alert's own action. */
  readonly onAction: () => void;
  readonly onFocusWithinChange: (focused: boolean) => void;
  readonly ref?: Ref<HTMLDivElement>;
}) {
  const { alert, visible, reducedMotion } = props;
  const contentRef = useRef<HTMLDivElement>(null);
  const shown = useRef<{ id: string | null; visible: boolean }>({ id: null, visible: false });

  useLayoutEffect(() => {
    const previous = shown.current;
    const id = alert?.id ?? null;
    shown.current = { id, visible };
    // Only a hand-over between two alerts animates; the first one morphs in with the island.
    if (id === null || previous.id === null || previous.id === id || !previous.visible) return;
    if (!visible || reducedMotion) return;
    contentRef.current?.animate(ALERT_SWAP_KEYFRAMES, ALERT_SWAP_TIMING);
  }, [alert?.id, visible, reducedMotion]);

  const Icon = alert ? ALERT_ICON[alertIconKey(alert)] : null;
  const sub = alert?.sub || props.fallbackSub;
  const when = alert?.live ? null : "just now";
  const meta = [sub, when].filter(Boolean).join(" · ");
  return (
    <div
      ref={ref}
      className="crown-layer crown-alert-layer"
      data-slot="crown-alert"
      data-visible={visible ? "true" : undefined}
      aria-hidden={visible ? undefined : true}
      inert={!visible || undefined}
      onClick={alert ? props.onOpen : undefined}
      onFocus={() => props.onFocusWithinChange(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) props.onFocusWithinChange(false);
      }}
    >
      <div ref={contentRef} className="crown-alert">
        {alert && Icon ? (
          <>
            <span className="crown-alert-icon">
              {alert.live ? (
                <Spinner aria-hidden="true" role={undefined} />
              ) : (
                <Icon aria-hidden="true" />
              )}
            </span>
            <div className="crown-alert-text" aria-live={alert.live ? "polite" : undefined}>
              <b>{alert.title}</b>
              {meta ? <small>{meta}</small> : null}
            </div>
            {alert.action ? (
              <button
                type="button"
                className="crown-alert-view"
                onClick={(event) => {
                  // The action replaces opening the card.
                  event.stopPropagation();
                  props.onAction();
                }}
              >
                {alert.action.label}
              </button>
            ) : (
              <button type="button" className="crown-alert-view" aria-label={`View ${alert.title}`}>
                View
              </button>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
