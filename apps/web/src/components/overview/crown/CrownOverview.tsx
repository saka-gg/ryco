import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";

import { usePaneFocus } from "../../chat/PaneFocus";
import { useEvent } from "../../../hooks/useEvent";
import { useReducedMotionEffective } from "../../../hooks/useAppearancePreference";
import { CrownAlert } from "./CrownAlert";
import { buildCrownSnapshot } from "./crownAlerts.logic";
import { CrownCard } from "./CrownCard";
import { CrownFace } from "./CrownFace";
import { CrownFlyout } from "./CrownFlyout";
import type { CrownMode } from "./crownGeometry.logic";
import { CrownIsland } from "./CrownIsland";
import { CROWN_FACE_RING_GAP_PCT, CROWN_GEOMETRY_STYLE } from "./crownLayout";
import {
  buildCheckRingSegments,
  buildCrownRailSummary,
  resolveCrownHeadline,
} from "./crownModel.logic";
import { CrownPreviewDock } from "./CrownPreviewDock";
import { CrownRailNav } from "./CrownRailNav";
import {
  crownSectionForRailKey,
  visibleCrownRailItems,
  type CrownRailKey,
  type CrownSection,
} from "./crownSections";
import type { CrownOverviewProps } from "./crownTypes";
import { ISLAND_DARK_TOKEN_STYLE } from "./islandTheme";
import { useCrownAlerts } from "./useCrownAlerts";
import { useCrownFlyout } from "./useCrownFlyout";
import { useCrownGeometry } from "./useCrownGeometry";

/** The folded card keeps its detail through the layer fade-out (.55s), then drops it. */
const CARD_CONTENT_LINGER_MS = 600;

const ROOT_STYLE = { ...ISLAND_DARK_TOKEN_STYLE, ...CROWN_GEOMETRY_STYLE };

const POPUP_SELECTOR = '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]';

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.closest("input, textarea, select") !== null;
}

/** Focus can go back to an element that is still mounted and no longer inert. */
function canFocus(element: HTMLElement | null): element is HTMLElement {
  return element !== null && element.isConnected && element.closest("[inert]") === null;
}

/** Focus was dropped to the document, e.g. by its element turning inert. */
function isFocusDropped(): boolean {
  return document.activeElement === null || document.activeElement === document.body;
}

/**
 * The Crown overview (prototype "Crown", output/overview-concepts/rail-island.html):
 * a 48px island-material icon rail headed by a round island. The island shows
 * the most urgent state, morphs into queued alerts that glow in their tone,
 * and expands into a card that swallows the rail as its spine. Hovering an
 * icon grows a preview flyout out of it.
 *
 * Self-contained presenter: everything is derived from the overview props.
 * It mounts inside a positioned slot whose box bounds the card and flyout;
 * `open` drives the enter / exit transition while the parent delays unmount.
 */
export function CrownOverview(props: CrownOverviewProps & { readonly open?: boolean }) {
  const { open = true, isGitRepo } = props;
  const notes = props.notes?.available ? props.notes : undefined;
  const reducedMotion = useReducedMotionEffective();
  const paneFocused = usePaneFocus();

  const [cardOpen, setCardOpen] = useState(false);
  const [cardContentMounted, setCardContentMounted] = useState(false);
  const [selected, setSelected] = useState<CrownSection | null>(null);
  /** The note a "Note saved" alert opened the card on; it flashes in the pane. */
  const [highlightNoteId, setHighlightNoteId] = useState<string | null>(null);

  const summary = buildCrownRailSummary(props, {
    isGitRepo,
    notesCount: notes?.counts.worktree ?? 0,
  });
  const headline = resolveCrownHeadline(summary, props);
  const items = visibleCrownRailItems({ isGitRepo, notesAvailable: notes !== undefined });
  const faceSegments = isGitRepo
    ? buildCheckRingSegments(props.pullRequest?.latestRuns ?? [], {
        gapPct: CROWN_FACE_RING_GAP_PCT,
      })
    : [];
  const refName = props.changes?.refName ?? null;

  const [alertFocused, setAlertFocused] = useState(false);
  const alerts = useCrownAlerts({
    snapshot: buildCrownSnapshot({
      scopeKey: props.scopeKey,
      layout: props,
      readiness: props.readiness,
      latestTurn: props.latestTurn,
      turnSettled: props.turnSettled,
      agentRunning: props.agentRunning,
      notes,
    }),
    cardOpen,
    userGitActionActive: props.userGitActionActive,
    paused: alertFocused,
  });
  // The alert layer keeps its last alert through the fold-back (adjusted during render).
  const [shownAlert, setShownAlert] = useState(alerts.current);
  if (alerts.current && alerts.current !== shownAlert) setShownAlert(alerts.current);

  const mode: CrownMode = cardOpen ? "card" : alerts.current ? "alert" : "dot";
  const headlineSection = headline.section;
  const selectedSection = selected === "notes" && !notes ? null : selected;
  const cardSection: CrownSection = selectedSection ?? headlineSection;
  const flyout = useCrownFlyout({ enabled: mode !== "card" });

  // A composer focused in the Notes preview holds the flyout: leaving it or
  // hovering another icon would drop the draft. Focus leaving lets it close.
  const [flyoutEditingRaw, setFlyoutEditing] = useState(false);
  const flyoutEditing = flyoutEditingRaw && flyout.openKey === "notes";
  const pointerInFlyoutRef = useRef(false);
  const onRailPointerOver = (key: CrownRailKey, el: HTMLElement) => {
    if (flyoutEditing && key !== flyout.openKey) return;
    flyout.onRailPointerOver(key, el);
  };
  const onRailPointerLeave = () => {
    if (!flyoutEditing) flyout.onRailPointerLeave();
  };
  const onFlyoutPointerEnter = () => {
    pointerInFlyoutRef.current = true;
    flyout.onFlyoutPointerEnter();
  };
  const onFlyoutPointerLeave = () => {
    pointerInFlyoutRef.current = false;
    if (!flyoutEditing) flyout.onFlyoutPointerLeave();
  };
  const onFlyoutEditingChange = (editing: boolean) => {
    setFlyoutEditing(editing);
    if (!editing && !pointerInFlyoutRef.current && flyout.openKey !== null) {
      flyout.onFlyoutPointerLeave();
    }
  };

  // Opening the Notes section (card or preview) re-reads the project's notes.
  const notesShown =
    notes !== undefined && ((cardOpen && cardSection === "notes") || flyout.openKey === "notes");
  const refreshNotes = useEvent(() => props.notes?.refresh());
  useEffect(() => {
    if (notesShown) refreshNotes();
  }, [notesShown, refreshNotes]);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const boundsRef = useRef<HTMLElement | null>(null);
  const islandRef = useRef<HTMLDivElement>(null);
  const alertLayerRef = useRef<HTMLDivElement>(null);
  const cardMainRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const faceRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const setRoot = useCallback((element: HTMLDivElement | null) => {
    rootRef.current = element;
    // The slot the crown mounts in bounds the card and the flyout.
    boundsRef.current = element?.parentElement ?? null;
  }, []);
  // Backstop: an alert leaving while its View button has focus hands focus to
  // the face before the layer turns inert. Declared before the geometry
  // effect, whose measuring could let the browser drop the focus first.
  const previousModeRef = useRef(mode);
  useLayoutEffect(() => {
    const leftAlert = previousModeRef.current === "alert" && mode !== "alert";
    previousModeRef.current = mode;
    if (leftAlert && alertLayerRef.current?.contains(document.activeElement)) {
      faceRef.current?.focus({ preventScroll: true });
    }
  }, [mode]);
  useCrownGeometry({ islandRef, alertLayerRef, cardMainRef, railRef, boundsRef, mode });

  // Focus: into the card when opened from the keyboard, back to the trigger on collapse.
  const triggerRef = useRef<HTMLElement | null>(null);
  const focusCardOnOpenRef = useRef(false);
  const restoreFocusRef = useRef(false);

  const openCard = (
    section: CrownSection,
    trigger: HTMLElement | null,
    viaKeyboard: boolean,
    noteId: string | null = null,
  ) => {
    if (section === "notes" && !notes) return;
    flyout.close();
    triggerRef.current = trigger;
    // The Notes pane focuses its own composer when the card opens on it.
    focusCardOnOpenRef.current =
      viaKeyboard && !(section === "notes" && notes?.composerDisabledReason === null);
    setHighlightNoteId(section === "notes" ? noteId : null);
    setSelected(section);
    setCardContentMounted(true);
    setCardOpen(true);
  };

  const collapse = useEvent((restoreFocus: boolean) => {
    if (!cardOpen) return;
    // A rail button clicked to open the card dropped its focus when the rail
    // turned inert; outside presses collapse without restoring, so a dropped
    // focus here was the crown's.
    restoreFocusRef.current =
      restoreFocus &&
      (rootRef.current?.contains(document.activeElement) === true || isFocusDropped());
    setHighlightNoteId(null);
    setCardOpen(false);
  });

  useEffect(() => {
    if (cardOpen) {
      if (!focusCardOnOpenRef.current) return;
      focusCardOnOpenRef.current = false;
      closeButtonRef.current?.focus({ preventScroll: true });
      return;
    }
    if (!restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    const target = canFocus(triggerRef.current) ? triggerRef.current : faceRef.current;
    target?.focus({ preventScroll: true });
  }, [cardOpen]);

  useEffect(() => {
    if (cardOpen) return;
    const timer = setTimeout(
      () => setCardContentMounted(false),
      reducedMotion ? 0 : CARD_CONTENT_LINGER_MS,
    );
    return () => clearTimeout(timer);
  }, [cardOpen, reducedMotion]);

  // Esc folds everything back (prototype `Crown.escape`): flyout, alerts and card.
  const handleEscape = useEvent((event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (isEditableTarget(event.target)) return;
    // A menu or dialog (often portaled out of the card) owns its own Escape.
    if (event.target instanceof Element && event.target.closest(POPUP_SELECTOR)) return;
    flyout.close();
    if (alertLayerRef.current?.contains(document.activeElement)) {
      faceRef.current?.focus({ preventScroll: true });
    }
    alerts.clear();
    collapse(true);
  });
  // Only the focused pane's crown answers Escape (each split pane mounts one).
  const escapeArmed = paneFocused && (mode !== "dot" || flyout.openKey !== null);
  useEffect(() => {
    if (!escapeArmed) return;
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [escapeArmed, handleEscape]);

  // Outside press collapses the card. Presses in popups portaled from the card
  // still bubble through the React tree, so the root's capture handler marks
  // them as inside before the document listener sees the native event.
  const insidePressRef = useRef<Event | null>(null);
  useEffect(() => {
    if (!cardOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (insidePressRef.current === event) return;
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      collapse(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [cardOpen, collapse]);

  const onFaceClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (cardOpen) {
      triggerRef.current = event.currentTarget;
      collapse(true);
      return;
    }
    if (mode === "alert" && shownAlert) {
      openCard(
        shownAlert.section,
        event.currentTarget,
        event.detail === 0,
        shownAlert.noteId ?? null,
      );
      return;
    }
    openCard(headlineSection, event.currentTarget, event.detail === 0);
  };

  const onAlertOpen = (event: MouseEvent<HTMLElement>) => {
    if (!shownAlert) return;
    openCard(shownAlert.section, faceRef.current, event.detail === 0, shownAlert.noteId ?? null);
  };

  const onRailClick = (key: CrownRailKey, button: HTMLElement, event: MouseEvent) => {
    openCard(crownSectionForRailKey(key), button, event.detail === 0);
  };

  const onSpineClick = (key: CrownRailKey) => {
    const section = crownSectionForRailKey(key);
    if (section === "notes" && !notes) return;
    setHighlightNoteId(null);
    setSelected(section);
  };

  return (
    <div
      ref={setRoot}
      className="dark crown-root pointer-events-auto absolute right-3 z-30 w-12"
      data-slot="crown-overview"
      data-state={open ? "open" : "closed"}
      data-mode={mode}
      data-motion={reducedMotion ? "reduced" : undefined}
      inert={!open || undefined}
      style={ROOT_STYLE}
      onPointerDownCapture={(event) => {
        insidePressRef.current = event.nativeEvent;
      }}
    >
      <CrownIsland ref={islandRef} mode={mode} tone={shownAlert?.tone ?? null}>
        <CrownFace
          ref={faceRef}
          headline={headline}
          segments={faceSegments}
          queuedCount={alerts.queuedCount}
          expanded={cardOpen}
          reducedMotion={reducedMotion}
          onClick={onFaceClick}
        />
        <CrownAlert
          ref={alertLayerRef}
          alert={shownAlert}
          fallbackSub={refName ?? ""}
          visible={mode === "alert"}
          reducedMotion={reducedMotion}
          onOpen={onAlertOpen}
          onFocusWithinChange={setAlertFocused}
        />
        <CrownCard
          mainRef={cardMainRef}
          closeButtonRef={closeButtonRef}
          section={cardSection}
          visible={mode === "card"}
          contentMounted={cardContentMounted}
          layout={props}
          isGitRepo={isGitRepo}
          agentRunning={props.agentRunning}
          branchName={refName}
          notes={notes}
          highlightNoteId={highlightNoteId}
          onCollapse={() => collapse(true)}
          spine={
            <CrownRailNav
              variant="spine"
              items={items}
              summary={summary}
              pings={alerts.pings}
              activeKey={cardSection}
              onItemClick={onSpineClick}
            />
          }
        />
      </CrownIsland>
      <CrownRailNav
        ref={railRef}
        variant="rail"
        items={items}
        summary={summary}
        pings={alerts.pings}
        activeKey={flyout.openKey}
        inert={mode === "card"}
        onItemClick={onRailClick}
        onItemPointerOver={onRailPointerOver}
        onPointerLeave={onRailPointerLeave}
      />
      <CrownFlyout
        openKey={flyout.openKey}
        anchorEl={flyout.anchorEl}
        rootRef={rootRef}
        railRef={railRef}
        layout={props}
        isGitRepo={isGitRepo}
        reducedMotion={reducedMotion}
        notes={notes}
        onPointerEnter={onFlyoutPointerEnter}
        onPointerLeave={onFlyoutPointerLeave}
        onEditingChange={onFlyoutEditingChange}
      />
      {props.preview ? <CrownPreviewDock>{props.preview}</CrownPreviewDock> : null}
      <span className="sr-only" role="status">
        {alerts.current?.title ?? ""}
      </span>
    </div>
  );
}
