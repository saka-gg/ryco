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
  return { tabs, selected: tabs.find((tab) => tab.id === selected) ?? tabs[0] ?? null, api };
}
export function projectBrowserKey(environmentId: string | null, cwd: string | null): string {
  return JSON.stringify([environmentId, cwd]);
}
export function normalizeBrowserUrl(value: string): string {
  const raw = value.trim();
  const url = new URL(/^[a-z][a-z\d+.-]*:\/\//iu.test(raw) ? raw : `http://${raw}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.hostname)
    throw new Error("Enter an HTTP(S) URL without embedded credentials.");
  return url.href;
}
