import { useEffect } from "react";
import { create } from "zustand";
import type { ProjectBrowserState, ProjectBrowserTab } from "@ryco/contracts";

interface BrowserUiState {
  native: ProjectBrowserState;
  fallback: ProjectBrowserTab[];
  selected: Record<string, string>;
  setNative(state: ProjectBrowserState): void;
  select(project: string, id: string): void;
  openFallback(url: string, project: string): string;
  navigateFallback(id: string, url: string): void;
  closeFallback(id: string): void;
}
export const useBrowserUi = create<BrowserUiState>((set) => ({
  native: { tabs: [] },
  fallback: [],
  selected: {},
  setNative: (native) => set({ native }),
  select: (project, id) => set((state) => ({ selected: { ...state.selected, [project]: id } })),
  openFallback: (url, project) => {
    const id = crypto.randomUUID();
    set((state) => ({
      fallback: [
        ...state.fallback,
        {
          id,
          project,
          url,
          title: new URL(url).host,
          loading: false,
          canGoBack: false,
          canGoForward: false,
          zoom: 1,
          presentation: "panel",
          error: null,
        },
      ],
      selected: { ...state.selected, [project]: id },
    }));
    return id;
  },
  closeFallback: (id) =>
    set((state) => ({ fallback: state.fallback.filter((tab) => tab.id !== id) })),
  navigateFallback: (id, url) =>
    set((state) => ({
      fallback: state.fallback.map((tab) =>
        tab.id === id ? { ...tab, url, title: new URL(url).host } : tab,
      ),
    })),
}));
let subscribers = 0;
let unsubscribe: (() => void) | undefined;
let subscriptionGeneration = 0;
export function useProjectBrowserTabs(project: string) {
  const api = window.desktopBridge?.browser;
  useEffect(() => {
    if (!api) return;
    if (subscribers++ === 0) {
      const generation = ++subscriptionGeneration;
      let changed = false;
      unsubscribe = api.onState((state) => {
        changed = true;
        useBrowserUi.getState().setNative(state);
      });
      void api
        .getState()
        .then((state) => {
          if (!changed && subscribers && generation === subscriptionGeneration)
            useBrowserUi.getState().setNative(state);
        })
        .catch(() => {});
    }
    return () => {
      if (--subscribers === 0) {
        subscriptionGeneration++;
        unsubscribe?.();
        unsubscribe = undefined;
      }
    };
  }, [api]);
  const all = useBrowserUi((state) => (api ? state.native.tabs : state.fallback));
  const selected = useBrowserUi((state) => state.selected[project]);
  const tabs = all.filter((tab) => tab.project === project || tab.project === "");
  // A tab an agent just handed to the user comes forward, once per request, unless the user is
  // typing somewhere else right now (the card and the alert tell them instead).
  const handedOff = tabs.find(
    (tab) => tab.handoff !== undefined && !broughtForward.has(tab.handoff.request),
  );
  useEffect(() => {
    if (handedOff?.handoff === undefined) return;
    broughtForward.add(handedOff.handoff.request);
    if (broughtForward.size > 200) {
      const oldest = broughtForward.values().next().value;
      if (oldest !== undefined) broughtForward.delete(oldest);
    }
    if (!userIsTypingElsewhere()) useBrowserUi.getState().select(project, handedOff.id);
  }, [handedOff?.id, handedOff?.handoff, project]);
  return { tabs, selected: tabs.find((tab) => tab.id === selected) ?? tabs[0] ?? null, api };
}

/** Hand-off requests whose tab was already brought forward (or skipped because the user typed). */
const broughtForward = new Set<string>();
/** The user counts as typing elsewhere for this long after a key press in an editable field. */
const TYPING_MS = 3_000;
let lastEditableKeyAt = 0;
if (typeof window !== "undefined") {
  window.addEventListener(
    "keydown",
    (event) => {
      if (isEditable(event.target)) lastEditableKeyAt = Date.now();
    },
    { capture: true, passive: true },
  );
}
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && !["button", "checkbox", "radio"].includes(target.type))
  );
}
function userIsTypingElsewhere(): boolean {
  return isEditable(document.activeElement) && Date.now() - lastEditableKeyAt < TYPING_MS;
}

/**
 * Shows the tab in the project's Browser panel: selects it for the project, then `open` (the
 * workspace's panel opener). False when this window has no such tab (another computer's, or gone).
 */
export function showProjectBrowserTab(project: string, tab: string, open: () => void): boolean {
  const state = useBrowserUi.getState();
  if (!state.native.tabs.some((candidate) => candidate.id === tab)) return false;
  state.select(project, tab);
  open();
  return true;
}
export function projectBrowserKey(environmentId: string | null, cwd: string | null): string {
  return JSON.stringify([environmentId, cwd]);
}
export { normalizeBrowserUrl } from "@ryco/shared/browserUrl";
