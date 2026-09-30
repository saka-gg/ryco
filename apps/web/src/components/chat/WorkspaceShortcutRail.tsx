import { Children, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  FolderIcon,
  GlobeIcon,
  TerminalIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { OverviewRailSections } from "../overview/OverviewRailSections";
import type { OverviewLayoutProps } from "../overview/overviewTypes";
import type { RightPanelMode } from "~/rightPanelRouteSearch";
import {
  WORKSPACE_SHORTCUT_CLASS_NAME,
  WORKSPACE_SHORTCUT_LABEL_CLASS_NAME,
} from "./workspaceShortcutStyles";

interface WorkspaceShortcutRailProps {
  overviewOpen: boolean;
  overview: OverviewLayoutProps;
  workspaceMode: RightPanelMode | null;
  canBrowseFiles: boolean;
  onToggleOverview: () => void;
  onOpenFiles: () => void;
  onOpenTerminal: () => void;
  onOpenBrowser: () => void;
  children?: ReactNode;
}

/** Compact desktop overview; its data owner and mutation controls remain shared with phone. */
export function WorkspaceShortcutRail(props: WorkspaceShortcutRailProps) {
  const [hoverExpanded, setExpanded] = useState(false);
  const expanded = hoverExpanded || props.overviewOpen;
  const root = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pointerInside = useRef(false);
  const clearTimer = () => clearTimeout(timer.current);
  const hasFocusOrOpenMenu = () =>
    (root.current?.contains(document.activeElement) &&
      document.activeElement?.matches(":focus-visible")) ||
    Boolean(root.current?.querySelector('[aria-haspopup][aria-expanded="true"]'));
  useEffect(() => () => clearTimeout(timer.current), []);

  const actions = [
    {
      label: "Files",
      Icon: FolderIcon,
      onClick: props.onOpenFiles,
      active: props.workspaceMode === "files",
      disabled: !props.canBrowseFiles,
    },
    {
      label: "Terminal",
      Icon: TerminalIcon,
      onClick: props.onOpenTerminal,
      active: props.workspaceMode === "terminal",
      disabled: false,
    },
    {
      label: "Browser",
      Icon: GlobeIcon,
      onClick: props.onOpenBrowser,
      active: props.workspaceMode === "browser",
      disabled: false,
    },
  ];

  return (
    <nav
      ref={root}
      aria-label="Overview"
      data-expanded={expanded}
      className={cn(
        "group/shortcuts selection-glass-surface absolute top-[calc(var(--chat-header-clearance,0px)+0.75rem)] right-3 z-30 rounded-xl border border-border/70 p-1 shadow-sm transition-[width,box-shadow] duration-250 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
        "before:absolute before:inset-y-0 before:-left-3 before:w-3",
        expanded ? "w-64 shadow-lg" : "w-11",
      )}
      onPointerEnter={(event) => {
        if (event.pointerType === "touch") return;
        pointerInside.current = true;
        clearTimer();
        timer.current = setTimeout(() => setExpanded(true), 160);
      }}
      onPointerLeave={() => {
        pointerInside.current = false;
        clearTimer();
        timer.current = setTimeout(() => {
          if (!hasFocusOrOpenMenu()) setExpanded(false);
        }, 240);
      }}
      onFocusCapture={(event) => {
        clearTimer();
        if (event.target.matches(":focus-visible")) setExpanded(true);
      }}
      onClickCapture={(event) => {
        const trigger = (event.target as HTMLElement).closest("[aria-haspopup]");
        if (trigger && event.currentTarget.contains(trigger)) {
          clearTimer();
          setExpanded(true);
        }
      }}
      onBlurCapture={(event) => {
        // Menus are portalled. They own their focus; closing them restores the
        // same trigger, so no controls are unmounted when the rail collapses.
        if (
          !pointerInside.current &&
          !event.currentTarget.contains(event.relatedTarget) &&
          !root.current?.querySelector('[aria-expanded="true"]')
        ) {
          setExpanded(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        // Let portalled menus handle their own Escape and focus restoration.
        if (!event.currentTarget.contains(event.target as Node)) return;
        clearTimer();
        setExpanded(false);
        if (props.overviewOpen) props.onToggleOverview();
        event.stopPropagation();
      }}
    >
      <div className="max-h-[calc(100dvh-var(--chat-header-clearance,0px)-3rem)] overflow-x-hidden overflow-y-auto overscroll-contain [scrollbar-width:none]">
        <div className="flex flex-col gap-1">
          <OverviewRailSections overview={props.overview} />
          <div className="my-1 border-t border-border/60" />
          {actions.map(({ label, Icon, onClick, active, disabled }) => (
            <button
              key={label}
              type="button"
              aria-label={label}
              aria-pressed={active}
              disabled={disabled}
              className={cn(
                WORKSPACE_SHORTCUT_CLASS_NAME,
                "disabled:pointer-events-none disabled:opacity-40",
              )}
              onClick={() => {
                clearTimer();
                setExpanded(false);
                onClick();
              }}
            >
              <Icon aria-hidden="true" />
              <span className={WORKSPACE_SHORTCUT_LABEL_CLASS_NAME}>{label}</span>
            </button>
          ))}
          {Children.toArray(props.children).length > 0 ? (
            <div className="mt-1 flex flex-col gap-1 border-t border-border/60 pt-1">
              {props.children}
            </div>
          ) : null}
          <button
            type="button"
            aria-label={props.overviewOpen ? "Collapse overview" : "Expand overview"}
            aria-expanded={props.overviewOpen}
            className={WORKSPACE_SHORTCUT_CLASS_NAME}
            onClick={() => {
              setExpanded(false);
              props.onToggleOverview();
            }}
          >
            {props.overviewOpen ? (
              <ChevronRightIcon aria-hidden="true" />
            ) : (
              <ChevronLeftIcon aria-hidden="true" />
            )}
            <span className={WORKSPACE_SHORTCUT_LABEL_CLASS_NAME}>
              {props.overviewOpen ? "Collapse" : "Keep expanded"}
            </span>
          </button>
        </div>
      </div>
    </nav>
  );
}
