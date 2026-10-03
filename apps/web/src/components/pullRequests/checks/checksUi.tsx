import { ChevronRightIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from "react";

import { cn } from "../../../lib/utils";
import { readMotionDurationMs } from "../../../lib/perf/motion";
import { usePullRequestsPage } from "../PullRequestsPageContext";
import { usePullRequestReaderStore } from "../pullRequestsLayoutStore";
import type { PullRequestsTab } from "../pullRequestsSearch";

/**
 * Small pieces the Checks and Commits tabs share: the disclosure shell, the
 * hover-revealed row actions, a count that rolls when it changes, the
 * landing flash, and per-tab scroll memory.
 */

/** Icon-sized row action (⋯, copy) that matches the bar's icon buttons. */
export const ROW_ICON_BUTTON_CLASS =
  "relative inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-hidden transition-[color,background-color,opacity] duration-(--app-motion-duration-chip) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

/**
 * Revealed with its row (`group/row`): hover, keyboard focus anywhere in the
 * row, or an open menu. Always shown on touch, where there is no hover.
 */
export const ROW_HOVER_REVEAL_CLASS =
  "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100 pointer-coarse:opacity-100";

/** Height disclosure: `grid-template-rows` 0fr ↔ 1fr plus opacity, on the house tokens. */
export function Disclosure(props: {
  readonly open: boolean;
  readonly id?: string | undefined;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}) {
  // Children mount on first open and stay, so closing animates the real content.
  const [rendered, setRendered] = useState(props.open);
  if (props.open && !rendered) setRendered(true);
  return (
    <div
      id={props.id}
      inert={!props.open}
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-(--app-motion-duration-stack) ease-(--app-motion-spring-gentle)",
        props.open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        props.className,
      )}
    >
      <div className="min-h-0 overflow-hidden">{rendered ? props.children : null}</div>
    </div>
  );
}

export function DisclosureChevron(props: {
  readonly open: boolean;
  readonly className?: string | undefined;
}) {
  return (
    <ChevronRightIcon
      aria-hidden
      className={cn(
        "size-3 shrink-0 text-muted-foreground/70 transition-transform duration-(--app-motion-duration-chip) ease-(--app-motion-spring-snappy)",
        props.open && "rotate-90",
        props.className,
      )}
    />
  );
}

/**
 * A number that rolls in from below when it changes (never on first paint).
 * The old value leaves at once, so the two never overlap.
 */
export function RollingCount(props: { readonly value: number }) {
  const [state, setState] = useState({ value: props.value, changed: false });
  if (state.value !== props.value) setState({ value: props.value, changed: true });
  return (
    <span
      key={props.value}
      className={cn("inline-block tabular-nums", state.changed && "pr-checks-count-in")}
    >
      {props.value}
    </span>
  );
}

export type LandingFlashMode = "motion" | "static";

export interface LandingFlash {
  readonly key: string;
  readonly mode: LandingFlashMode;
  readonly token: number;
}

const LANDING_FLASH_MS = 1600;

/** Class for a row that is the target of a deep link. */
export function landingFlashClass(flash: LandingFlash | null, key: string): string | undefined {
  if (flash?.key !== key) return undefined;
  return flash.mode === "motion" ? "pr-checks-flash" : "pr-checks-flash-static";
}

/**
 * The deep-link landing highlight: one `overview-jump-flash` pass, or a
 * static ring for the same time when motion is reduced.
 */
export function useLandingFlash() {
  const [flash, setFlash] = useState<LandingFlash | null>(null);
  useEffect(() => {
    if (flash === null) return;
    const timer = window.setTimeout(() => setFlash(null), LANDING_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flash]);
  const trigger = useCallback((key: string) => {
    const mode: LandingFlashMode =
      readMotionDurationMs("--app-motion-duration-pop", 200) === 0 ? "static" : "motion";
    setFlash((current) => ({ key, mode, token: (current?.token ?? 0) + 1 }));
  }, []);
  return { flash, trigger };
}

/** Scrolls an element to the top of its pane, smoothly unless motion is reduced. */
export function scrollRowIntoView(element: HTMLElement) {
  const smooth = readMotionDurationMs("--app-motion-duration-pane", 360) > 0;
  element.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
}

const SCROLL_SAVE_DELAY_MS = 120;

/**
 * Remembers a tab's scroll offset per pull request (reader store), so coming
 * back to a pull request lands where the reader left it. Restores once the
 * content is `ready` (skeletons are shorter than the real list).
 */
export function useTabScrollMemory(tab: PullRequestsTab, ready: boolean) {
  const { readerKey } = usePullRequestsPage();
  const setScrollTop = usePullRequestReaderStore((state) => state.setScrollTop);
  const ref = useRef<HTMLDivElement>(null);
  const restoredRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (!ready || restoredRef.current || readerKey === null) return;
    restoredRef.current = true;
    const top = usePullRequestReaderStore.getState().scrollTop[`${readerKey}\0${tab}`];
    if (top && ref.current) ref.current.scrollTop = top;
  }, [ready, readerKey, tab]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const onScroll = useCallback(
    (event: UIEvent<HTMLElement>) => {
      if (readerKey === null) return;
      const element = event.currentTarget;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setScrollTop(readerKey, tab, element.scrollTop);
      }, SCROLL_SAVE_DELAY_MS);
    },
    [readerKey, setScrollTop, tab],
  );

  return { ref, onScroll };
}
