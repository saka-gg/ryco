import { Suspense, lazy, useCallback, type CSSProperties, type ReactNode } from "react";

import {
  PREFERS_REDUCED_MOTION_QUERY,
  resolveInactivePanelContentVisibilityStyle,
} from "../lib/perf/motion";
import type { RightPanelMode, RightPanelRouteSearch } from "../rightPanelRouteSearch";
import {
  buildCloseWorkspacePanelSearch,
  type WorkspacePanelSearchKey,
} from "../workspaceRouteSearch";
import { Sidebar, SidebarProvider, SidebarRail } from "~/components/ui/sidebar";
import { cn } from "~/lib/utils";
import { useDelayedUnmount } from "~/hooks/useDelayedUnmount";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";
import {
  DiffPanelHeaderSkeleton,
  DiffPanelLoadingState,
  DiffPanelShell,
  type DiffPanelMode,
} from "./DiffPanelShell";

const ThreadWorkspacePanel = lazy(() => import("./ThreadWorkspacePanel"));

const RIGHT_PANEL_INLINE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_diff_sidebar_width";
const RIGHT_PANEL_INLINE_DEFAULT_WIDTH = "clamp(24rem,34vw,36rem)";
const RIGHT_PANEL_INLINE_SIDEBAR_MIN_WIDTH = 22 * 16;
const RIGHT_PANEL_INLINE_SIDEBAR_MAX_WIDTH = 56 * 16;
const RIGHT_PANEL_INLINE_EXIT_DURATION_MS = 360;
const RIGHT_PANEL_RESIZE_RAIL_CLASS_NAME =
  "w-5 cursor-ew-resize after:w-px after:bg-border/50 hover:after:bg-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-0";
const COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX = 208;

export function closeRightPanelSearch<T extends Record<string, unknown>>(
  params: T,
): Omit<T, WorkspacePanelSearchKey> & RightPanelRouteSearch {
  return buildCloseWorkspacePanelSearch(params);
}

const RightPanelLoadingFallback = (props: { mode: DiffPanelMode; label: string }) => {
  return (
    <DiffPanelShell mode={props.mode} header={<DiffPanelHeaderSkeleton />}>
      <DiffPanelLoadingState label={props.label} />
    </DiffPanelShell>
  );
};

// The column, its slide and this content fade all run on the pane duration and
// curve shared with the overview column (`OverviewSidebarMotionFrame`), so the
// two right-side surfaces trade places as one motion.
const RIGHT_PANEL_MOTION_CLASS_NAME =
  "duration-(--app-motion-duration-pane) ease-(--app-motion-ease) motion-reduce:transition-none";

function RightPanelContentMotionFrame(props: { children: ReactNode; open: boolean }) {
  return (
    <div
      aria-hidden={props.open ? undefined : true}
      inert={props.open ? undefined : true}
      className={cn(
        "flex min-h-0 w-full flex-1 transition-[translate,opacity] will-change-transform starting:translate-x-4 starting:opacity-0",
        RIGHT_PANEL_MOTION_CLASS_NAME,
        props.open ? "translate-x-0 opacity-100" : "translate-x-4 opacity-0",
      )}
    >
      {props.children}
    </div>
  );
}

export const LazyRightPanel = (props: {
  mode: DiffPanelMode;
  panelMode: RightPanelMode | null;
  openedPanelModes: ReadonlyArray<RightPanelMode>;
  openedAgentKeys: ReadonlyArray<string>;
  /** The page tab's render while it is open; it shows one HTML render at a time. */
  openedRenderKey?: string | null;
  onClosePanelTab: (input: { mode: RightPanelMode; agentKey?: string }) => void;
  maximized?: boolean;
  onToggleMaximized?: (() => void) | undefined;
  reserveChromeInset?: boolean;
}) => {
  return (
    <DiffWorkerPoolProvider>
      <Suspense
        fallback={
          <RightPanelLoadingFallback
            mode={props.mode}
            label={
              props.panelMode === "review"
                ? "Loading diff viewer..."
                : props.panelMode === "files"
                  ? "Loading file preview..."
                  : props.panelMode === "terminal"
                    ? "Loading terminal..."
                    : props.panelMode === "simulator"
                      ? "Loading simulator..."
                      : props.panelMode === "pullRequest"
                        ? "Loading pull request..."
                        : props.panelMode === "agents"
                          ? "Loading agents..."
                          : props.panelMode === "agent"
                            ? "Loading subagent thread..."
                            : props.panelMode === "render"
                              ? "Loading page..."
                              : "Loading workspace..."
            }
          />
        }
      >
        <ThreadWorkspacePanel
          mode={props.mode}
          panelMode={props.panelMode}
          openedPanelModes={props.openedPanelModes}
          openedAgentKeys={props.openedAgentKeys}
          openedRenderKey={props.openedRenderKey ?? null}
          onClosePanelTab={props.onClosePanelTab}
          maximized={props.maximized ?? false}
          onToggleMaximized={props.onToggleMaximized}
          reserveChromeInset={props.reserveChromeInset ?? false}
        />
      </Suspense>
    </DiffWorkerPoolProvider>
  );
};

export const RightPanelInlineSidebar = (props: {
  open: boolean;
  panelMode: RightPanelMode | null;
  openedPanelModes: ReadonlyArray<RightPanelMode>;
  openedAgentKeys: ReadonlyArray<string>;
  openedRenderKey?: string | null;
  onClosePanelTab: (input: { mode: RightPanelMode; agentKey?: string }) => void;
  onClose: () => void;
  onOpen: () => void;
  renderContent: boolean;
  /** Fills the workspace instead of sitting in a resizable column. */
  maximized: boolean;
  onToggleMaximized: () => void;
  /** The maximized panel owns the workspace's top-left chrome corner. */
  reserveChromeInset: boolean;
}) => {
  const { maximized, open, onClose, onOpen, panelMode, renderContent } = props;
  const prefersReducedMotion = useMediaQuery(PREFERS_REDUCED_MOTION_QUERY);
  const renderPanelSurface = useDelayedUnmount(
    open,
    prefersReducedMotion ? 0 : RIGHT_PANEL_INLINE_EXIT_DURATION_MS,
  );
  const panelContentVisibilityStyle = resolveInactivePanelContentVisibilityStyle({
    active: renderPanelSurface,
    containIntrinsicSize: "28rem 100vh",
  });
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        onOpen();
        return;
      }
      onClose();
    },
    [onClose, onOpen],
  );
  const shouldAcceptInlineSidebarWidth = useCallback(
    ({ nextWidth, wrapper }: { nextWidth: number; wrapper: HTMLElement }) => {
      const composerForm = document.querySelector<HTMLElement>("[data-chat-composer-form='true']");
      if (!composerForm) return true;
      const composerViewport = composerForm.parentElement;
      if (!composerViewport) return true;
      const previousSidebarWidth = wrapper.style.getPropertyValue("--sidebar-width");
      wrapper.style.setProperty("--sidebar-width", `${nextWidth}px`);

      const viewportStyle = window.getComputedStyle(composerViewport);
      const viewportPaddingLeft = Number.parseFloat(viewportStyle.paddingLeft) || 0;
      const viewportPaddingRight = Number.parseFloat(viewportStyle.paddingRight) || 0;
      const viewportContentWidth = Math.max(
        0,
        composerViewport.clientWidth - viewportPaddingLeft - viewportPaddingRight,
      );
      const formRect = composerForm.getBoundingClientRect();
      const composerFooter = composerForm.querySelector<HTMLElement>(
        "[data-chat-composer-footer='true']",
      );
      const composerRightActions = composerForm.querySelector<HTMLElement>(
        "[data-chat-composer-actions='right']",
      );
      const composerRightActionsWidth = composerRightActions?.getBoundingClientRect().width ?? 0;
      const composerFooterGap = composerFooter
        ? Number.parseFloat(window.getComputedStyle(composerFooter).columnGap) ||
          Number.parseFloat(window.getComputedStyle(composerFooter).gap) ||
          0
        : 0;
      const minimumComposerWidth =
        COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX + composerRightActionsWidth + composerFooterGap;
      const hasComposerOverflow = composerForm.scrollWidth > composerForm.clientWidth + 0.5;
      const overflowsViewport = formRect.width > viewportContentWidth + 0.5;
      const violatesMinimumComposerWidth = composerForm.clientWidth + 0.5 < minimumComposerWidth;

      if (previousSidebarWidth.length > 0) {
        wrapper.style.setProperty("--sidebar-width", previousSidebarWidth);
      } else {
        wrapper.style.removeProperty("--sidebar-width");
      }

      return !hasComposerOverflow && !overflowsViewport && !violatesMinimumComposerWidth;
    },
    [],
  );

  return (
    <SidebarProvider
      defaultOpen={false}
      open
      onOpenChange={onOpenChange}
      className={cn(
        "min-h-0 bg-transparent",
        // A maximized panel takes the whole workspace line, so there is no
        // column width left to animate.
        maximized
          ? "min-w-0 flex-1"
          : cn(
              "flex-none transition-[width]",
              RIGHT_PANEL_MOTION_CLASS_NAME,
              open ? "w-(--sidebar-width)" : "w-0",
            ),
      )}
      style={{ "--sidebar-width": RIGHT_PANEL_INLINE_DEFAULT_WIDTH } as CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        maximized={maximized}
        className={cn(
          "border-l border-border bg-card text-foreground",
          maximized
            ? "translate-x-0"
            : cn(
                "transition-[translate,width]",
                RIGHT_PANEL_MOTION_CLASS_NAME,
                open ? "translate-x-0" : "pointer-events-none translate-x-full",
              ),
        )}
        resizable={{
          maxWidth: RIGHT_PANEL_INLINE_SIDEBAR_MAX_WIDTH,
          minWidth: RIGHT_PANEL_INLINE_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: shouldAcceptInlineSidebarWidth,
          storageKey: RIGHT_PANEL_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        <RightPanelContentMotionFrame open={open}>
          <div className="flex min-h-0 w-full flex-1" style={panelContentVisibilityStyle}>
            {renderContent && renderPanelSurface ? (
              <LazyRightPanel
                mode="sidebar"
                panelMode={panelMode}
                openedPanelModes={props.openedPanelModes}
                openedAgentKeys={props.openedAgentKeys}
                openedRenderKey={props.openedRenderKey ?? null}
                onClosePanelTab={props.onClosePanelTab}
                maximized={maximized}
                onToggleMaximized={props.onToggleMaximized}
                reserveChromeInset={props.reserveChromeInset}
              />
            ) : null}
          </div>
        </RightPanelContentMotionFrame>
        {maximized ? null : (
          <SidebarRail
            aria-label="Resize workspace panel"
            className={RIGHT_PANEL_RESIZE_RAIL_CLASS_NAME}
            title="Drag to resize workspace panel"
          />
        )}
      </Sidebar>
    </SidebarProvider>
  );
};
